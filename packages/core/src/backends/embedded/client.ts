import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Span, LogRecord } from '../../types.js';
import { TraceOnError } from '../../errors.js';
import type { EvidenceBackend, WaitForTraceOptions, LogTimeWindow } from '../interface.js';
import { DEFAULT_WAIT, waitForTraceSettle } from '../shared.js';
import type { EmbeddedConfig } from '../config.js';
import { parseTraces, parseLogs } from './parser.js';
import { EmbeddedCollector, DEFAULT_OTLP_PORT, collectorPaths } from './collector.js';
import { ensureCollectorBinary } from './binary.js';

export type { EmbeddedConfig };

export function defaultDataDir(): string {
  return join(homedir(), '.traceon', 'embedded');
}

/**
 * Minimal surface the backend needs from the collector — a seam so the
 * contract tests can stub process management instead of spawning binaries.
 */
export interface CollectorLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  isAlive(): boolean;
  readonly port: number;
}

export class EmbeddedBackend implements EvidenceBackend {
  private readonly waitDefaults: WaitForTraceOptions;
  readonly tracesFile: string;
  readonly logsFile: string;

  constructor(
    private readonly collector: CollectorLike,
    private readonly dataDir: string,
    settle: Partial<WaitForTraceOptions> = {},
  ) {
    const p = collectorPaths(dataDir);
    this.tracesFile = p.tracesFile;
    this.logsFile = p.logsFile;
    this.waitDefaults = { ...DEFAULT_WAIT, ...settle };
  }

  /**
   * Bring the collector up BEFORE the test runs (push-style backend: spans
   * arrive while Playwright executes). Clears output files from previous
   * sessions first — per-trace filtering makes stale data harmless for
   * correctness, but unbounded NDJSON growth makes every poll slower.
   * Safe because the collector isn't running yet at this point.
   */
  async start(): Promise<void> {
    if (!this.collector.isAlive()) {
      rmSync(this.tracesFile, { force: true });
      rmSync(this.logsFile, { force: true });
    }
    await this.collector.start();
  }

  async health(): Promise<{ ok: boolean }> {
    return { ok: this.collector.isAlive() };
  }

  unreachableError(): TraceOnError {
    // Same code as SigNoz (the skill pattern-matches on it); embedded-mode
    // remediation text.
    return new TraceOnError(
      'TRACE_BACKEND_UNREACHABLE',
      'The embedded OTel collector is not running',
      `The collector subprocess died or failed to start. Check the collector log at ${join(this.dataDir, 'collector.log')}; re-running the verify will restart it.`,
    );
  }

  private readSpansForTrace(traceId: string): Span[] {
    if (!existsSync(this.tracesFile)) return [];
    const content = readFileSync(this.tracesFile, 'utf-8');
    // Pre-filter to NDJSON lines mentioning this traceId BEFORE the (much
    // costlier) JSON parse, so a large multi-trace file isn't fully re-parsed
    // on every settle poll. The hex traceId appears verbatim in any OTLP/JSON
    // line carrying it; a batched line with other traces is still parsed and
    // filtered below, so this is a safe superset, not a lossy shortcut.
    const relevant = content
      .split('\n')
      .filter((line) => line.includes(traceId))
      .join('\n');
    if (!relevant) return [];
    return parseTraces(relevant).filter((s) => s.trace_id === traceId);
  }

  private collectorDownError(): TraceOnError {
    return new TraceOnError(
      'EMBEDDED_COLLECTOR_DOWN',
      'The embedded OTel collector died while waiting for the trace to settle',
      `Spans received before the crash are preserved. Check the collector log at ${join(this.dataDir, 'collector.log')} for the cause, then re-run the verify.`,
    );
  }

  /**
   * Decision A settle heuristic (shared with SigNoz via waitForTraceSettle):
   * poll the File-exporter output, settle when the per-trace span count is
   * stable for stabilityMs, give up (incomplete, not an error) at maxWaitMs —
   * and bail out hard if the collector dies mid-wait.
   */
  async waitForTrace(traceId: string, opts?: WaitForTraceOptions): Promise<{ complete: boolean }> {
    return waitForTraceSettle(
      () => this.readSpansForTrace(traceId).length,
      opts ?? this.waitDefaults,
      () => {
        if (!this.collector.isAlive()) throw this.collectorDownError();
      },
    );
  }

  async fetchSpans(traceId: string): Promise<Span[]> {
    return this.readSpansForTrace(traceId);
  }

  async fetchLogs(traceId: string, window: LogTimeWindow): Promise<LogRecord[]> {
    if (!existsSync(this.logsFile)) return [];
    const all = parseLogs(readFileSync(this.logsFile, 'utf-8'));
    // SigNoz parity: trace-correlated logs within the test's time window.
    return all.filter(
      (l) => l.trace_id === traceId && l.ts >= window.startMs && l.ts <= window.endMs,
    );
  }

  /**
   * Per-verify close is a no-op: the collector is server-lifetime (it must
   * outlive any single verify so back-to-back runs don't pay a restart, and
   * so late spans from the previous run still land). Process teardown goes
   * through shutdownEmbeddedBackend().
   */
  async close(): Promise<void> {}
}

// One collector per MCP-server process, keyed by its effective config.
// handleVerify runs serially per server, so swapping the shared instance when
// a different project's config arrives is race-free.
let shared: { backend: EmbeddedBackend; collector: EmbeddedCollector; signature: string } | null = null;

function configSignature(opts: EmbeddedConfig & { dataDir: string; port: number }): string {
  return JSON.stringify({ port: opts.port, dataDir: opts.dataDir, settle: opts.settle ?? {} });
}

export interface GetEmbeddedBackendOptions extends EmbeddedConfig {
  /** Injectable for tests. Defaults to the real lazy download. */
  ensureBinary?: () => Promise<string>;
}

/**
 * Get (lazily creating) the process-wide embedded backend. The first call
 * resolves the collector binary — downloading it if `traceon init` somehow
 * didn't — and constructs the collector; `backend.start()` actually spawns.
 */
export async function getEmbeddedBackend(
  opts: GetEmbeddedBackendOptions = {},
): Promise<EmbeddedBackend> {
  const dataDir = opts.dataDir ?? defaultDataDir();
  const port = opts.port ?? DEFAULT_OTLP_PORT;
  const signature = configSignature({ ...opts, dataDir, port });

  if (shared) {
    if (shared.signature === signature) return shared.backend;
    // A different project/config arrived in the same server process (different
    // port/dataDir/settle). Tear down the old collector before standing up the
    // new one so we don't leak a subprocess or bind-conflict on the port —
    // otherwise the cached collector would silently serve the wrong project.
    await shared.collector.stop();
    shared = null;
  }

  const binaryPath = await (opts.ensureBinary ?? (() => ensureCollectorBinary()))();
  const collector = new EmbeddedCollector({ binaryPath, dataDir, port });
  const backend = new EmbeddedBackend(collector, dataDir, opts.settle ?? {});
  shared = { backend, collector, signature };
  return backend;
}

/** Stop the shared collector. Called from the MCP server's shutdown path. */
export async function shutdownEmbeddedBackend(): Promise<void> {
  const current = shared;
  shared = null;
  if (current) await current.collector.stop();
}
