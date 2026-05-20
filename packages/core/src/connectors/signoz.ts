import type { Span, LogRecord, SpanEvent } from '../types.js';

export interface SigNozConfig {
  /** Base URL, e.g. http://localhost:8080 (note: v0.50+ runs UI+API on :8080) */
  baseUrl: string;
  /** SigNoz API key. Required by SigNoz v0.30+. Sent as SIGNOZ-API-KEY header. */
  apiKey?: string;
}

export interface WaitForTraceOptions {
  maxWaitMs: number;
  stabilityMs: number;
}

const DEFAULT_WAIT: WaitForTraceOptions = { maxWaitMs: 60_000, stabilityMs: 10_000 };
const TRACE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

// SigNoz v3 list queries require non-empty selectColumns. SigNoz only renders a
// fixed whitelist of names as bare table columns; anything else (including the
// attributes_* map columns themselves) gets rewritten to an attribute_string_<key>
// lookup, which fails. So we select only confirmed-bare columns, and pull
// individual semantic attributes via tag-style entries (which render as
// attributes_string['<key>']).
const col = (key: string, dataType: string = 'string') => ({ key, dataType, type: '', isColumn: true });
const tag = (key: string, dataType: string = 'string') => ({ key, dataType, type: 'tag', isColumn: false });

const TRACE_LIST_COLUMNS = [
  col('timestamp'),
  col('span_id'),
  col('parent_span_id'),
  col('trace_id'),
  col('name'),
  col('status_code'),
  col('status_message'),
  col('duration_nano', 'int64'),
  col('has_error', 'bool'),
  col('response_status_code'),
  // Semantic attributes pulled from attributes_string by key.
  tag('service.name'),
  tag('http.status_code'),
  tag('http.method'),
  tag('http.route'),
  tag('code.filepath'),
];

const LOG_LIST_COLUMNS = [
  col('timestamp'),
  col('severity_text'),
  col('body'),
  col('trace_id'),
  col('span_id'),
  tag('service.name'),
];

interface QueryRangeListItem {
  timestamp?: string;
  data?: Record<string, unknown>;
}
interface QueryRangeResponse {
  status?: string;
  data?: { result?: Array<{ queryName?: string; list?: QueryRangeListItem[] }> };
  error?: string;
}

function nanosToMs(value: unknown): number {
  if (typeof value === 'number') return Math.floor(value / 1_000_000);
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n / 1_000_000) : 0;
  }
  return 0;
}

function isoToMs(value: unknown): number {
  if (typeof value !== 'string') return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function statusFromSigNoz(raw: Record<string, unknown>): Span['status'] {
  if (raw['hasError'] === true) return 'ERROR';
  const code = raw['statusCode'];
  if (code === 2) return 'ERROR';
  if (code === 1) return 'OK';
  const codeStr = raw['statusCodeString'];
  if (typeof codeStr === 'string') {
    if (codeStr.endsWith('ERROR')) return 'ERROR';
    if (codeStr.endsWith('OK')) return 'OK';
  }
  return 'UNSET';
}

function mergeTagMaps(raw: Record<string, unknown>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const key of ['stringTagMap', 'numberTagMap', 'boolTagMap', 'attributes_string', 'attributes_number', 'attributes_bool']) {
    const m = raw[key];
    if (m && typeof m === 'object' && !Array.isArray(m)) {
      for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = v;
      }
    }
  }
  return out;
}

function parseEvents(raw: unknown): SpanEvent[] {
  let arr: unknown = raw;
  if (typeof arr === 'string') {
    try { arr = JSON.parse(arr); } catch { return []; }
  }
  if (!Array.isArray(arr)) return [];
  const events: SpanEvent[] = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const ev = e as Record<string, unknown>;
    const ts = typeof ev['timeUnixNano'] === 'string' || typeof ev['timeUnixNano'] === 'number'
      ? nanosToMs(ev['timeUnixNano'])
      : isoToMs(ev['timestamp']);
    const attributes: Record<string, string | number | boolean> = {};
    const a = ev['attributeMap'] ?? ev['attributes'];
    if (a && typeof a === 'object' && !Array.isArray(a)) {
      for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') attributes[k] = v;
      }
    }
    events.push({ name: typeof ev['name'] === 'string' ? ev['name'] : 'event', ts, attributes });
  }
  return events;
}

export class SigNozClient {
  constructor(private readonly config: SigNozConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h['SIGNOZ-API-KEY'] = this.config.apiKey;
    return h;
  }

  private async queryRange(body: unknown): Promise<QueryRangeResponse> {
    const res = await fetch(`${this.config.baseUrl}/api/v3/query_range`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`SigNoz query_range failed: ${res.status} ${res.statusText}`);
    return (await res.json()) as QueryRangeResponse;
  }

  private listQuery(dataSource: 'traces' | 'logs', traceIdKey: string, traceId: string, start: number, end: number) {
    return {
      start,
      end,
      step: 60,
      variables: {},
      compositeQuery: {
        queryType: 'builder',
        panelType: 'list',
        builderQueries: {
          A: {
            queryName: 'A',
            dataSource,
            aggregateOperator: 'noop',
            aggregateAttribute: { key: '', dataType: 'string', type: 'tag', isColumn: false },
            filters: {
              op: 'AND',
              items: [{
                // Traces: SigNoz recognises `traceID` as a top-level column even when
                // tagged. Logs: `trace_id` only resolves to the bare column when type
                // is empty — with `type: 'tag'` SigNoz rewrites it to
                // attribute_string_trace_id, which doesn't exist on the logs table.
                key: dataSource === 'logs'
                  ? { key: traceIdKey, dataType: 'string', type: '', isColumn: true }
                  : { key: traceIdKey, dataType: 'string', type: 'tag', isColumn: true },
                op: '=',
                value: traceId,
              }],
            },
            expression: 'A',
            disabled: false,
            limit: 10000,
            offset: 0,
            pageSize: 1000,
            orderBy: [{ columnName: 'timestamp', order: 'asc' }],
            selectColumns: dataSource === 'traces' ? TRACE_LIST_COLUMNS : LOG_LIST_COLUMNS,
          },
        },
      },
    };
  }

  async waitForTraceComplete(traceId: string, opts: WaitForTraceOptions = DEFAULT_WAIT): Promise<{ complete: boolean }> {
    const start = Date.now();
    let lastCount = 0;
    let lastChangeAt = Date.now();

    while (Date.now() - start < opts.maxWaitMs) {
      const spans = await this.fetchSpans(traceId);
      if (spans.length !== lastCount) {
        lastCount = spans.length;
        lastChangeAt = Date.now();
      } else if (lastCount > 0 && Date.now() - lastChangeAt > opts.stabilityMs) {
        return { complete: true };
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { complete: false };
  }

  async fetchSpans(traceId: string): Promise<Span[]> {
    const now = Date.now();
    const body = this.listQuery('traces', 'traceID', traceId, now - TRACE_LOOKBACK_MS, now);
    const raw = await this.queryRange(body);
    return this.normalizeSpans(raw);
  }

  async fetchLogs(traceId: string, timeWindow: { startMs: number; endMs: number }): Promise<LogRecord[]> {
    const body = this.listQuery('logs', 'trace_id', traceId, timeWindow.startMs, timeWindow.endMs);
    const raw = await this.queryRange(body);
    return this.normalizeLogs(raw);
  }

  private normalizeSpans(raw: QueryRangeResponse): Span[] {
    const list = raw.data?.result?.[0]?.list ?? [];
    const out: Span[] = [];
    for (const item of list) {
      const d = item.data ?? {};
      const attributes = mergeTagMaps(d);
      const start = typeof d['startTimeUnixNano'] !== 'undefined'
        ? nanosToMs(d['startTimeUnixNano'])
        : isoToMs(item.timestamp);
      const duration = nanosToMs(d['durationNano']);
      const end = typeof d['endTimeUnixNano'] !== 'undefined' ? nanosToMs(d['endTimeUnixNano']) : start + duration;
      const httpCode = d['responseStatusCode'] ?? d['httpStatusCode'];
      if (typeof httpCode === 'number') attributes['http.status_code'] = httpCode;
      else if (typeof httpCode === 'string' && httpCode.length > 0 && Number.isFinite(Number(httpCode))) {
        attributes['http.status_code'] = Number(httpCode);
      }
      out.push({
        span_id: String(d['spanID'] ?? d['span_id'] ?? ''),
        parent_span_id: typeof d['parentSpanID'] === 'string' && d['parentSpanID'].length > 0
          ? (d['parentSpanID'] as string)
          : undefined,
        trace_id: String(d['traceID'] ?? d['trace_id'] ?? ''),
        name: String(d['name'] ?? ''),
        service: String(d['serviceName'] ?? d['service.name'] ?? attributes['service.name'] ?? ''),
        status: statusFromSigNoz(d),
        start_ts: start,
        end_ts: end,
        duration_ms: duration,
        attributes,
        events: parseEvents(d['events']),
      });
    }
    return out;
  }

  private normalizeLogs(raw: QueryRangeResponse): LogRecord[] {
    const list = raw.data?.result?.[0]?.list ?? [];
    const out: LogRecord[] = [];
    for (const item of list) {
      const d = item.data ?? {};
      const ts = typeof d['timestamp'] === 'string'
        ? isoToMs(d['timestamp'])
        : typeof d['timestamp'] === 'number' ? d['timestamp'] : isoToMs(item.timestamp);
      const sev = String(d['severity_text'] ?? d['level'] ?? 'info').toLowerCase();
      const level: LogRecord['level'] =
        sev === 'trace' || sev === 'debug' || sev === 'info' || sev === 'warn' || sev === 'error' || sev === 'fatal'
          ? sev
          : sev === 'warning' ? 'warn'
          : 'info';
      const attributes = mergeTagMaps(d);
      const traceIdRaw = d['trace_id'] ?? d['traceID'];
      const spanIdRaw = d['span_id'] ?? d['spanID'];
      out.push({
        ts,
        service: String(d['service.name'] ?? d['serviceName'] ?? attributes['service.name'] ?? ''),
        level,
        body: String(d['body'] ?? d['message'] ?? ''),
        trace_id: typeof traceIdRaw === 'string' && traceIdRaw.length > 0 ? traceIdRaw : undefined,
        span_id: typeof spanIdRaw === 'string' && spanIdRaw.length > 0 ? spanIdRaw : undefined,
        attributes,
      });
    }
    return out;
  }
}
