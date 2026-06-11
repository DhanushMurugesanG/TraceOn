import type { Span, LogRecord, SpanEvent } from '../../types.js';

/**
 * Parser for the OTel File exporter's `format: json` output: newline-
 * delimited JSON, one OTLP/JSON ExportTraceServiceRequest (or
 * ExportLogsServiceRequest) per line, as produced by otelcol-contrib's
 * pdata JSON marshaler. Shape verified against a live 0.154.0 run — see
 * tests/fixtures/embedded/*.ndjson.
 *
 * OTLP/JSON encodes trace/span IDs as lowercase hex (not base64 — that's
 * the older proto3-JSON convention; we accept it as a fallback anyway),
 * timestamps as stringified unix nanos, and attribute values as tagged
 * AnyValue objects ({stringValue}/{intValue}/...).
 */

type AnyValue = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: unknown;
  kvlistValue?: unknown;
};

type KeyValue = { key?: string; value?: AnyValue };

function attrValue(v: AnyValue | undefined): string | number | boolean | undefined {
  if (!v || typeof v !== 'object') return undefined;
  if (typeof v.stringValue === 'string') return v.stringValue;
  if (typeof v.boolValue === 'boolean') return v.boolValue;
  if (typeof v.doubleValue === 'number') return v.doubleValue;
  if (v.intValue !== undefined) {
    const n = Number(v.intValue);
    return Number.isFinite(n) ? n : String(v.intValue);
  }
  // Arrays / nested kvlists don't fit the flat Record type; skip them the
  // same way the SigNoz normalizer keeps primitives only.
  return undefined;
}

function flattenAttributes(list: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list as KeyValue[]) {
    if (!item || typeof item.key !== 'string') continue;
    const v = attrValue(item.value);
    if (v !== undefined) out[item.key] = v;
  }
  return out;
}

function nanosToMs(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? Math.floor(n / 1_000_000) : 0;
}

/** Normalize an OTLP/JSON id: lowercase hex passthrough, base64 fallback. */
export function normalizeId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  if (/^[0-9a-fA-F]+$/.test(raw)) return raw.toLowerCase();
  try {
    return Buffer.from(raw, 'base64').toString('hex');
  } catch {
    return raw;
  }
}

function spanStatus(status: { code?: number | string } | undefined): Span['status'] {
  // OTLP status codes: 0 UNSET, 1 OK, 2 ERROR. The pdata JSON marshaler may
  // also emit the enum name as a string.
  const code = status?.code;
  if (code === 2 || code === 'STATUS_CODE_ERROR') return 'ERROR';
  if (code === 1 || code === 'STATUS_CODE_OK') return 'OK';
  return 'UNSET';
}

function parseSpanEvents(raw: unknown): SpanEvent[] {
  if (!Array.isArray(raw)) return [];
  const events: SpanEvent[] = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const ev = e as Record<string, unknown>;
    events.push({
      name: typeof ev['name'] === 'string' ? ev['name'] : 'event',
      ts: nanosToMs(ev['timeUnixNano']),
      attributes: flattenAttributes(ev['attributes']),
    });
  }
  return events;
}

/** Each NDJSON line parsed independently; malformed lines are skipped the
 *  same way gather.ts skips malformed browser-event lines. */
function* jsonLines(content: string): Generator<Record<string, unknown>> {
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === 'object') yield parsed as Record<string, unknown>;
    } catch {
      // ignore malformed line (partial flush, truncated write)
    }
  }
}

export function parseTraces(content: string): Span[] {
  const out: Span[] = [];
  for (const req of jsonLines(content)) {
    const resourceSpans = req['resourceSpans'];
    if (!Array.isArray(resourceSpans)) continue;
    for (const rs of resourceSpans as Array<Record<string, unknown>>) {
      const resourceAttrs = flattenAttributes(
        (rs['resource'] as Record<string, unknown> | undefined)?.['attributes'],
      );
      const service = String(resourceAttrs['service.name'] ?? '');
      const scopeSpans = rs['scopeSpans'];
      if (!Array.isArray(scopeSpans)) continue;
      for (const ss of scopeSpans as Array<Record<string, unknown>>) {
        const spans = ss['spans'];
        if (!Array.isArray(spans)) continue;
        for (const s of spans as Array<Record<string, unknown>>) {
          const attributes = flattenAttributes(s['attributes']);
          const start = nanosToMs(s['startTimeUnixNano']);
          const end = nanosToMs(s['endTimeUnixNano']);
          // SigNoz parity: surface a numeric http.status_code attribute when
          // the span carries one in any of the semconv spellings.
          const httpCode =
            attributes['http.status_code'] ?? attributes['http.response.status_code'];
          if (typeof httpCode === 'string' && httpCode.length > 0 && Number.isFinite(Number(httpCode))) {
            attributes['http.status_code'] = Number(httpCode);
          } else if (typeof httpCode === 'number') {
            attributes['http.status_code'] = httpCode;
          }
          const parent = normalizeId(s['parentSpanId']);
          out.push({
            span_id: normalizeId(s['spanId']),
            ...(parent ? { parent_span_id: parent } : {}),
            trace_id: normalizeId(s['traceId']),
            name: String(s['name'] ?? ''),
            service,
            status: spanStatus(s['status'] as { code?: number | string } | undefined),
            start_ts: start,
            end_ts: end,
            duration_ms: Math.max(0, end - start),
            attributes,
            events: parseSpanEvents(s['events']),
          });
        }
      }
    }
  }
  return out;
}

const SEVERITY_TEXT_MAP: Record<string, LogRecord['level']> = {
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  error: 'error',
  fatal: 'fatal',
};

/** OTLP severityNumber ranges: 1-4 TRACE, 5-8 DEBUG, 9-12 INFO, 13-16 WARN,
 *  17-20 ERROR, 21-24 FATAL. Used when severityText is absent. */
function levelFromSeverityNumber(n: unknown): LogRecord['level'] | undefined {
  if (typeof n !== 'number' || n < 1) return undefined;
  if (n <= 4) return 'trace';
  if (n <= 8) return 'debug';
  if (n <= 12) return 'info';
  if (n <= 16) return 'warn';
  if (n <= 20) return 'error';
  if (n <= 24) return 'fatal';
  return undefined;
}

function logBody(body: unknown): string {
  if (body && typeof body === 'object') {
    const v = attrValue(body as AnyValue);
    if (v !== undefined) return String(v);
    return JSON.stringify(body);
  }
  return body === undefined || body === null ? '' : String(body);
}

export function parseLogs(content: string): LogRecord[] {
  const out: LogRecord[] = [];
  for (const req of jsonLines(content)) {
    const resourceLogs = req['resourceLogs'];
    if (!Array.isArray(resourceLogs)) continue;
    for (const rl of resourceLogs as Array<Record<string, unknown>>) {
      const resourceAttrs = flattenAttributes(
        (rl['resource'] as Record<string, unknown> | undefined)?.['attributes'],
      );
      const service = String(resourceAttrs['service.name'] ?? '');
      const scopeLogs = rl['scopeLogs'];
      if (!Array.isArray(scopeLogs)) continue;
      for (const sl of scopeLogs as Array<Record<string, unknown>>) {
        const records = sl['logRecords'];
        if (!Array.isArray(records)) continue;
        for (const r of records as Array<Record<string, unknown>>) {
          const sevText = typeof r['severityText'] === 'string' ? r['severityText'].toLowerCase() : '';
          const level =
            SEVERITY_TEXT_MAP[sevText] ?? levelFromSeverityNumber(r['severityNumber']) ?? 'info';
          const traceId = normalizeId(r['traceId']);
          const spanId = normalizeId(r['spanId']);
          out.push({
            ts: nanosToMs(r['timeUnixNano'] ?? r['observedTimeUnixNano']),
            service,
            level,
            body: logBody(r['body']),
            ...(traceId ? { trace_id: traceId } : {}),
            ...(spanId ? { span_id: spanId } : {}),
            attributes: flattenAttributes(r['attributes']),
          });
        }
      }
    }
  }
  return out;
}
