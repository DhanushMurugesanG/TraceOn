// packages/core/src/types.ts

/**
 * Identifiers
 */

/** ULID, e.g. 01HX2K7QF3MNRSGYE4ZW9PVCBA. TraceOn's run identifier. */
export type RunId = string;

/** 32-hex-character W3C trace ID. */
export type TraceId = string;

/** 16-hex-character W3C span ID. */
export type SpanId = string;

/**
 * Raw evidence (output of gather phase, input to ranker)
 */

export interface Span {
  span_id: SpanId;
  parent_span_id?: SpanId;
  trace_id: TraceId;
  name: string;
  service: string;
  status: "OK" | "ERROR" | "UNSET";
  start_ts: number;        // unix ms
  end_ts: number;          // unix ms (0 if incomplete)
  duration_ms: number;
  attributes: Record<string, string | number | boolean>;
  events: SpanEvent[];
}

export interface SpanEvent {
  name: string;
  ts: number;
  attributes: Record<string, string | number | boolean>;
}

export interface LogRecord {
  ts: number;              // unix ms
  service: string;
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  body: string;
  trace_id?: TraceId;
  span_id?: SpanId;
  attributes: Record<string, string | number | boolean>;
}

export interface BrowserEvent {
  kind: "console" | "page_error" | "network" | "navigation";
  ts: number;
  level?: "info" | "warn" | "error";
  text?: string;
  url?: string;
  status?: number;
  stack?: string;
  attributes: Record<string, string | number | boolean>;
}

export interface TestSummary {
  file: string;
  name: string;
  status: "passed" | "failed" | "timedOut" | "interrupted";
  duration_ms: number;
  steps_executed: string[];
  failure_message?: string;
}

export interface CoverageInfo {
  hits: string[];          // file paths that had spans
  misses: string[];        // changed files with zero spans
  warnings: string[];      // human-readable concerns
}

export interface RawEvidence {
  run_id: RunId;
  trace_id: TraceId;
  test_summary: TestSummary;
  spans: Span[];
  logs: LogRecord[];
  browser_events: BrowserEvent[];
  coverage: CoverageInfo;
  changed_files: string[];
  intent?: string;
  incomplete: boolean;     // true if trace wait timed out
}

/**
 * Ranker output
 */

export interface EvidenceRef {
  kind: "span" | "log" | "browser_event" | "assertion";
  id: string;
  service?: string;
  summary: string;         // one-line human-readable
  data: unknown;           // the verbatim evidence item
}

export interface RankedPacket {
  tier1: EvidenceRef[];
  tier2: EvidenceRef[];
  tier3_summary: string;
  budget_used: number;     // token estimate
  budget_total: number;
  omitted_summary?: string;
}

export interface RankerConfig {
  budget_total: number;    // total token budget (default 50000)
  tier3_summary_cap: number; // max tokens for tier 3 summary (default 500)
  slow_span_percentile: number; // threshold for "slow" spans (default 95)
}

/**
 * Final result returned to the agent
 */

export interface VerificationResult {
  run_id: RunId;
  trace_id: TraceId;
  test_status: TestSummary["status"];

  test_summary: {
    file: string;
    name: string;
    duration_ms: number;
    steps_executed: string[];
    failure_message?: string;
  };

  evidence_summary: {
    tier1_count: number;
    error_spans: number;
    error_logs: number;
    page_errors: number;
    http_5xx: number;
    http_4xx: number;
    incomplete: boolean;
  };

  coverage: CoverageInfo;
  ranked_packet: RankedPacket;
  intent_hint?: IntentHint;
  evidence_path: string;
}

export interface IntentHint {
  relevant_spans: string[];
  relevant_logs: string[];
  note?: string;
}
