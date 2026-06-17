import type { Span, LogRecord } from '../types.js';
import type { TraceOnError } from '../errors.js';

/**
 * Tuning for the trace-settle wait. Shared by every backend so the agent's
 * experience doesn't shift when the backend changes (see the embedded-mode
 * plan's "span-settle heuristic" risk).
 */
export interface WaitForTraceOptions {
  /** Hard ceiling on how long to wait for the trace to settle. */
  maxWaitMs: number;
  /** Declare the trace settled once the span count is unchanged for this long. */
  stabilityMs: number;
  /** How often to re-check the backend while waiting. */
  pollMs: number;
}

export interface LogTimeWindow {
  startMs: number;
  endMs: number;
}

/**
 * A pluggable source of runtime evidence keyed by trace id.
 *
 * SigNoz is one implementation (an HTTP query client); the embedded OTel
 * collector (v0.2.0) is another (a local subprocess + File-exporter reader).
 * gather.ts talks only to this interface — it does not know or care which
 * backend produced the evidence.
 */
export interface EvidenceBackend {
  /**
   * Pre-test lifecycle hook. Called BEFORE the Playwright test runs: backends
   * that receive pushed telemetry (embedded collector) must be listening
   * while the test executes, not just when evidence is read. Required on the
   * interface (not optional) so the contract is explicit — query-style
   * backends like SigNoz implement it as a no-op rather than omitting it,
   * which means the orchestrator never has to special-case a backend.
   */
  start(): Promise<void>;

  /**
   * Cheap reachability probe. When `ok` is false the gather short-circuits
   * and throws `unreachableError()` rather than polling into a timeout.
   */
  health(): Promise<{ ok: boolean }>;

  /** Wait until spans for this traceId stop arriving (settled) or we time out. */
  waitForTrace(traceId: string, opts?: WaitForTraceOptions): Promise<{ complete: boolean }>;

  /** All spans recorded for this traceId. */
  fetchSpans(traceId: string): Promise<Span[]>;

  /** Logs correlated to this traceId within the given time window. */
  fetchLogs(traceId: string, window: LogTimeWindow): Promise<LogRecord[]>;

  /** The error to throw when `health()` reports the backend is unreachable. */
  unreachableError(): TraceOnError;

  /**
   * Release any resources held by the backend (subprocesses, servers, etc.).
   * No-op for stateless HTTP backends; tears down the collector for embedded.
   */
  close(): Promise<void>;
}
