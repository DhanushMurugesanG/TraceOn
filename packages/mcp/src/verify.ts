import { z } from 'zod';
import { resolve } from 'path';
import { existsSync, mkdirSync } from 'fs';
import {
  rank,
  createBackend,
  gatherEvidence,
  RankerTier1OverflowError,
  TraceOnError,
  type VerificationResult,
  type RawEvidence,
  type IntentHint,
} from '@traceon/core';
import { generateRunId, generateTraceId } from './ids.js';
import { persistRun } from './persistence.js';
import { runPlaywright, findProjectRoot } from './playwright.js';
import { loadConfig } from './config.js';
import { checkSkillVersion, formatStaleSkillWarning } from './skill-version.js';

// Module-level "have we already checked this server's lifetime" flag.
// The skill file doesn't change between verify calls in a single MCP
// server process — checking once is enough, and noisy log lines on every
// invocation erode trust in the warning.
let skillVersionChecked = false;

export const verifyToolDefinition = {
  name: 'traceon_verify',
  description:
    'Run a Playwright test for a feature change and return ranked runtime evidence. Use this to verify the feature actually works end-to-end after editing code. Pass the test you wrote, the user\'s intent, and the files you changed. Pass `extra_env` to forward env vars (e.g. AUTH_TOKEN) to the Playwright subprocess; use `signoz_env` to pick a SigNoz config profile.',
  inputSchema: {
    type: 'object',
    required: ['test'],
    properties: {
      test: { type: 'string' },
      intent: { type: 'string' },
      changed_files: { type: 'array', items: { type: 'string' } },
      signoz_env: { type: 'string' },
      extra_env: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Extra environment variables forwarded to the Playwright subprocess (e.g. AUTH_TOKEN, API_BASE_URL).',
      },
      prior_run_id: { type: 'string' },
      iteration_index: { type: 'integer' },
    },
  },
} as const;

const VerifyArgs = z.object({
  test: z.string(),
  intent: z.string().optional(),
  changed_files: z.array(z.string()).default([]),
  signoz_env: z.string().default('default'),
  extra_env: z.record(z.string(), z.string()).default({}),
  prior_run_id: z.string().optional(),
  iteration_index: z.number().int().optional(),
});

export async function handleVerify(args: unknown): Promise<VerificationResult> {
  const parsed = VerifyArgs.parse(args);
  const config = loadConfig(parsed.signoz_env);

  const resolvedTest = resolve(parsed.test);
  if (!existsSync(resolvedTest)) {
    throw new TraceOnError(
      'TEST_FILE_NOT_FOUND',
      `Test file not found: ${parsed.test}`,
      `Check the path is correct relative to the project root. Resolved to: ${resolvedTest}`,
    );
  }

  // Skill-staleness check (once per server lifetime). If the project's
  // .claude/skills/traceon-verify/SKILL.md is from an older traceon-cli
  // install, the agent's instructions are out of date — warn the user so
  // they know to re-run `traceon init`. Soft warning to stderr, never
  // throws or blocks the verify call.
  if (!skillVersionChecked) {
    skillVersionChecked = true;
    try {
      const projectRoot = findProjectRoot(resolvedTest);
      const warning = formatStaleSkillWarning(checkSkillVersion(projectRoot));
      if (warning) console.error(warning);
    } catch { /* never let the check block the run */ }
  }

  const runId = generateRunId();
  const traceId = generateTraceId();
  const evidenceDir = resolve(config.evidenceRootDir, runId);
  try {
    mkdirSync(evidenceDir, { recursive: true });
  } catch (err) {
    throw new TraceOnError(
      'EVIDENCE_DIR_WRITE_FAILED',
      `Cannot create evidence directory: ${evidenceDir}`,
      `Check filesystem permissions for ${config.evidenceRootDir}. ${err instanceof Error ? err.message : ''}`.trim(),
      err,
    );
  }

  const testStartMs = Date.now();
  const testSummary = await runPlaywright({
    test: parsed.test,
    traceId,
    runId,
    evidenceDir,
    extraEnv: parsed.extra_env,
  });
  const testEndMs = Date.now();

  const backend = await createBackend({
    backend: 'signoz',
    signoz: config.signozApiKey
      ? { baseUrl: config.signozBaseUrl, apiKey: config.signozApiKey }
      : { baseUrl: config.signozBaseUrl },
  });

  try {
    const gathered = await gatherEvidence({
      runId,
      traceId,
      evidenceDir,
      testSummary,
      changedFiles: parsed.changed_files,
      intent: parsed.intent,
      backend,
      testStartMs,
      testEndMs,
    });
    const { evidence } = gathered;

    let rankedPacket;
    try {
      rankedPacket = rank(evidence);
    } catch (err) {
      if (err instanceof RankerTier1OverflowError) {
        throw new TraceOnError(
          'RANKER_TIER1_OVERFLOW',
          err.message,
          `The trace has too many high-priority items (${err.tier1Tokens} tokens vs ${err.budget} budget). The system is likely in a degraded state — investigate the backend for cascading failures before iterating.`,
          err,
        );
      }
      throw err;
    }
    persistRun({ runId, traceId, status: testSummary.status });

    const intentHint = computeIntentHint(evidence);

    return {
      run_id: runId,
      trace_id: traceId,
      test_status: testSummary.status,
      test_summary: {
        file: parsed.test,
        name: testSummary.name,
        duration_ms: testSummary.duration_ms,
        steps_executed: testSummary.steps_executed,
        failure_message: testSummary.failure_message,
      },
      evidence_summary: summarizeEvidence(evidence, rankedPacket.tier1.length),
      coverage: evidence.coverage,
      ranked_packet: rankedPacket,
      intent_hint: intentHint,
      evidence_path: evidenceDir,
    };
  } finally {
    await backend.close();
  }
}

function summarizeEvidence(evidence: RawEvidence, tier1Count: number) {
  let error_spans = 0;
  let http_5xx = 0;
  let http_4xx = 0;
  for (const span of evidence.spans) {
    if (span.status === 'ERROR') error_spans++;
    const codeAttr = span.attributes['http.status_code'];
    const code = typeof codeAttr === 'number' ? codeAttr : Number(codeAttr);
    if (Number.isFinite(code)) {
      if (code >= 500) http_5xx++;
      else if (code >= 400) http_4xx++;
    }
  }
  let error_logs = 0;
  for (const log of evidence.logs) {
    if (log.level === 'error' || log.level === 'fatal') error_logs++;
  }
  let page_errors = 0;
  for (const event of evidence.browser_events) {
    if (event.kind === 'page_error') page_errors++;
  }
  return {
    tier1_count: tier1Count,
    error_spans,
    error_logs,
    page_errors,
    http_5xx,
    http_4xx,
    incomplete: evidence.incomplete,
    no_trace_activity: evidence.no_trace_activity,
  };
}

function computeIntentHint(evidence: RawEvidence): IntentHint | undefined {
  if (!evidence.intent) return undefined;
  const keywords = evidence.intent
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 4);
  if (keywords.length === 0) return undefined;

  const match = (s: string) => {
    const lower = s.toLowerCase();
    return keywords.some((k) => lower.includes(k));
  };

  const relevant_spans: string[] = [];
  for (const span of evidence.spans) {
    if (match(span.name)) {
      relevant_spans.push(span.span_id);
      continue;
    }
    for (const v of Object.values(span.attributes)) {
      if (typeof v === 'string' && match(v)) {
        relevant_spans.push(span.span_id);
        break;
      }
    }
  }

  const relevant_logs: string[] = [];
  for (const log of evidence.logs) {
    if (match(log.body)) relevant_logs.push(`${log.service}:${log.ts}`);
  }

  if (relevant_spans.length === 0 && relevant_logs.length === 0) {
    return {
      relevant_spans: [],
      relevant_logs: [],
      note: 'No spans or logs matched the stated intent — the test may not have exercised the intended path.',
    };
  }
  return { relevant_spans, relevant_logs };
}
