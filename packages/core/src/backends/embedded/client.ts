import { existsSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Span, LogRecord } from '../../types.js';
import { TraceOnError } from '../../errors.js';
import type { EvidenceBackend, WaitForTraceOptions, LogTimeWindow } from '../interface.js';
import { parseTraces, parseLogs } from './parser.js';
import { EmbeddedCollector, DEFAULT_OTLP_PORT, collectorPaths } from './collector.js';
import { ensureCollectorBinary } from './binary.js';

// Settle defaults intentionally identical to the SigNoz backend so the
// agent's experience doesn't shift with the backend (plan risk register:
// "span-settle heuristic differs from SigNoz's behavior").
const DEFAULT_WAIT: WaitForTraceOptions = { maxWaitMs: 60_000, stabilityMs: 10_000, pollMs: 2_000 };

export interface EmbeddedConfig {
  port?: number;
  dataDir?: string;
  /** Override the settle defaults; exposed via the embedded config block. */
  settle?: Partial<WaitForTraceOptions>;
}

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
    const all = parseTraces(readFileSync(this.tracesFile, 'utf-8'));
    return all.filter((s) => s.trace_id === traceId);
  }

  /**
   * Decision A settle heuristic: poll the File-exporter output every pollMs,
   * declare settled when the per-trace span count is unchanged for
   * stabilityMs, give up (incomplete, not an error) at maxWaitMs — and bail
   * out hard if the collector dies mid-wait, falling back to the standard
   * unreachable error path instead of silently timing out.
   */
  async waitForTrace(traceId: string, opts?: WaitForTraceOptions): Promise<{ complete: boolean }> {
    const o = opts ?? this.waitDefaults;
    const start = Date.now();
    let lastCount = 0;
    let lastChangeAt = Date.now();

    while (Date.now() - start < o.maxWaitMs) {
      if (!this.collector.isAlive()) {
        throw new TraceOnError(
          'EMBEDDED_COLLECTOR_DOWN',
          'The embedded OTel collector died while waiting for the trace to settle',
          `Spans received before the crash are preserved. Check the collector log at ${join(this.dataDir, 'collector.log')} for the cause, then re-run the verify.`,
        );
      }
      const count = this.readSpansForTrace(traceId).length;
      if (count !== lastCount) {
        lastCount = count;
        lastChangeAt = Date.now();
      } else if (lastCount > 0 && Date.now() - lastChangeAt > o.stabilityMs) {
        return { complete: true };
      }
      await new Promise((r) => setTimeout(r, o.pollMs));
    }
    return { complete: false };
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

// One collector per MCP-server process. handleVerify runs serially per
// server, and the OTLP port is fixed — a second collector could never bind.
let shared: { backend: EmbeddedBackend; collector: EmbeddedCollector } | null = null;

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
  if (shared) return shared.backend;
  const binaryPath = await (opts.ensureBinary ?? (() => ensureCollectorBinary()))();
  const dataDir = opts.dataDir ?? defaultDataDir();
  const collector = new EmbeddedCollector({
    binaryPath,
    dataDir,
    port: opts.port ?? DEFAULT_OTLP_PORT,
  });
  const backend = new EmbeddedBackend(collector, dataDir, opts.settle ?? {});
  shared = { backend, collector };
  return backend;
}

/** Stop the shared collector. Called from the MCP server's shutdown path. */
export async function shutdownEmbeddedBackend(): Promise<void> {
  const current = shared;
  shared = null;
  if (current) await current.collector.stop();
}
