import { existsSync, readFileSync } from 'fs';
import { SigNozClient } from './connectors/signoz.js';
import { redactObject, type RedactionRecord } from './redact.js';
import { computeCoverage } from './coverage.js';
import { TraceOnError } from './errors.js';
import type { RawEvidence, BrowserEvent, TestSummary, Span, LogRecord } from './types.js';

export interface GatherOptions {
  runId: string;
  traceId: string;
  evidenceDir: string;
  testSummary: TestSummary;
  changedFiles: string[];
  intent?: string;
  signozClient: SigNozClient;
  testStartMs: number;
  testEndMs: number;
}

export interface GatherResult {
  evidence: RawEvidence;
  redactions: RedactionRecord[];
}

function readBrowserEvents(path: string): BrowserEvent[] {
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split('\n');
  const events: BrowserEvent[] = [];
  for (const line of lines) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as Partial<BrowserEvent> & { ts?: number; kind?: string };
      if (!parsed.kind || typeof parsed.ts !== 'number') continue;
      events.push({
        kind: parsed.kind as BrowserEvent['kind'],
        ts: parsed.ts,
        level: parsed.level,
        text: parsed.text,
        url: parsed.url,
        status: parsed.status,
        stack: parsed.stack,
        attributes: parsed.attributes ?? {},
      });
    } catch {
      // ignore malformed line
    }
  }
  return events;
}

export async function gatherEvidence(opts: GatherOptions): Promise<GatherResult> {
  // Read browser events first so we can decide whether to wait on SigNoz at all.
  // If the test never fired a fetch, no backend trace will arrive — skip the
  // 60s wait + the trace/log fetches entirely.
  const rawBrowserEvents = readBrowserEvents(`${opts.evidenceDir}/browser_events.jsonl`);
  const hasNetworkActivity = rawBrowserEvents.some((e) => e.kind === 'network');

  let rawSpans: Span[] = [];
  let rawLogs: LogRecord[] = [];
  let complete = true;

  if (hasNetworkActivity) {
    const health = await opts.signozClient.health();
    if (!health.ok) {
      throw new TraceOnError(
        'TRACE_BACKEND_UNREACHABLE',
        `SigNoz at ${opts.signozClient.config.baseUrl} is not responding`,
        `Start SigNoz with \`docker compose up -d\` and verify at ${opts.signozClient.config.baseUrl}. If the URL is wrong, set SIGNOZ_BASE_URL in the MCP server env.`,
      );
    }
    const wait = await opts.signozClient.waitForTraceComplete(opts.traceId);
    complete = wait.complete;
    rawSpans = await opts.signozClient.fetchSpans(opts.traceId);
    rawLogs = await opts.signozClient.fetchLogs(opts.traceId, {
      startMs: opts.testStartMs - 30_000,
      endMs: opts.testEndMs + 60_000,
    });
  }

  const spansR = redactObject<Span[]>(rawSpans, '$.spans');
  const logsR = redactObject<LogRecord[]>(rawLogs, '$.logs');
  const browserR = redactObject<BrowserEvent[]>(rawBrowserEvents, '$.browser_events');

  const coverage = computeCoverage(spansR.redacted, opts.changedFiles);

  const evidence: RawEvidence = {
    run_id: opts.runId,
    trace_id: opts.traceId,
    test_summary: opts.testSummary,
    spans: spansR.redacted,
    logs: logsR.redacted,
    browser_events: browserR.redacted,
    coverage,
    changed_files: opts.changedFiles,
    intent: opts.intent,
    incomplete: !complete,
    no_trace_activity: !hasNetworkActivity,
  };

  return { evidence, redactions: [...spansR.records, ...logsR.records, ...browserR.records] };
}
