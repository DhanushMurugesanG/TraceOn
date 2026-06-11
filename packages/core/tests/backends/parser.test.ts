import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseTraces, parseLogs, normalizeId } from '../../src/backends/embedded/parser.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'embedded');
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const SPAN_ID = 'b7ad6b7169203331';

describe('parseTraces against real otelcol-contrib 0.154.0 output', () => {
  const content = readFileSync(join(FIXTURES, 'traces.ndjson'), 'utf-8');

  it('parses the captured File-exporter line into a normalized Span', () => {
    const spans = parseTraces(content);
    expect(spans).toHaveLength(1);
    const s = spans[0]!;
    expect(s.trace_id).toBe(TRACE_ID);
    expect(s.span_id).toBe(SPAN_ID);
    expect(s.name).toBe('GET /spike');
    expect(s.service).toBe('spike-svc');
    expect(s.status).toBe('ERROR'); // status.code 2
    expect(s.parent_span_id).toBeUndefined();
    expect(s.duration_ms).toBe(5); // 5_000_000 nanos
    expect(s.start_ts).toBeGreaterThan(1_700_000_000_000);
    expect(s.end_ts).toBe(s.start_ts + 5);
    expect(s.attributes['http.status_code']).toBe(500); // intValue "500" → number
    expect(s.events).toEqual([]);
  });
});

describe('parseLogs against real otelcol-contrib 0.154.0 output', () => {
  const content = readFileSync(join(FIXTURES, 'logs.ndjson'), 'utf-8');

  it('parses the captured log line with trace correlation intact', () => {
    const logs = parseLogs(content);
    expect(logs).toHaveLength(1);
    const l = logs[0]!;
    expect(l.body).toBe('payment failed');
    expect(l.level).toBe('error'); // severityText ERROR
    expect(l.service).toBe('spike-svc');
    expect(l.trace_id).toBe(TRACE_ID);
    expect(l.span_id).toBe(SPAN_ID);
    expect(l.ts).toBeGreaterThan(1_700_000_000_000);
  });
});

describe('parseTraces edge cases', () => {
  function line(obj: unknown): string {
    return JSON.stringify(obj) + '\n';
  }

  function spanLine(span: Record<string, unknown>, resourceAttrs: unknown[] = []): string {
    return line({
      resourceSpans: [
        {
          resource: { attributes: resourceAttrs },
          scopeSpans: [{ scope: { name: 't' }, spans: [span] }],
        },
      ],
    });
  }

  it('skips malformed lines (partial flush) and keeps good ones', () => {
    const good = spanLine({ traceId: 'aa', spanId: 'bb', name: 'ok' });
    const content = '{"resourceSpans": [{"scopeSp\n' + good + '\nnot json at all\n';
    const spans = parseTraces(content);
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('ok');
  });

  it('aggregates spans across multiple NDJSON lines', () => {
    const content =
      spanLine({ traceId: 'aa', spanId: '01', name: 'first' }) +
      spanLine({ traceId: 'aa', spanId: '02', name: 'second' });
    expect(parseTraces(content)).toHaveLength(2);
  });

  it('keeps parent_span_id when present, omits when empty', () => {
    const withParent = parseTraces(
      spanLine({ traceId: 'aa', spanId: '02', parentSpanId: '01', name: 'child' }),
    )[0]!;
    expect(withParent.parent_span_id).toBe('01');
    const noParent = parseTraces(spanLine({ traceId: 'aa', spanId: '01', name: 'root' }))[0]!;
    expect(noParent.parent_span_id).toBeUndefined();
  });

  it('maps status enum names as well as numeric codes', () => {
    const byName = parseTraces(
      spanLine({ traceId: 'aa', spanId: '01', status: { code: 'STATUS_CODE_OK' } }),
    )[0]!;
    expect(byName.status).toBe('OK');
    const unset = parseTraces(spanLine({ traceId: 'aa', spanId: '01' }))[0]!;
    expect(unset.status).toBe('UNSET');
  });

  it('flattens AnyValue attribute types and skips non-primitives', () => {
    const s = parseTraces(
      spanLine({
        traceId: 'aa',
        spanId: '01',
        attributes: [
          { key: 'str', value: { stringValue: 'v' } },
          { key: 'int', value: { intValue: '42' } },
          { key: 'dbl', value: { doubleValue: 1.5 } },
          { key: 'bool', value: { boolValue: true } },
          { key: 'arr', value: { arrayValue: { values: [] } } },
        ],
      }),
    )[0]!;
    expect(s.attributes).toEqual({ str: 'v', int: 42, dbl: 1.5, bool: true });
  });

  it('normalizes http.response.status_code (new semconv) onto http.status_code', () => {
    const s = parseTraces(
      spanLine({
        traceId: 'aa',
        spanId: '01',
        attributes: [{ key: 'http.response.status_code', value: { intValue: '404' } }],
      }),
    )[0]!;
    expect(s.attributes['http.status_code']).toBe(404);
  });

  it('parses span events with timestamps and attributes', () => {
    const s = parseTraces(
      spanLine({
        traceId: 'aa',
        spanId: '01',
        events: [
          {
            name: 'exception',
            timeUnixNano: '1700000000000000000',
            attributes: [{ key: 'exception.message', value: { stringValue: 'boom' } }],
          },
        ],
      }),
    )[0]!;
    expect(s.events).toHaveLength(1);
    expect(s.events[0]!.name).toBe('exception');
    expect(s.events[0]!.ts).toBe(1_700_000_000_000);
    expect(s.events[0]!.attributes['exception.message']).toBe('boom');
  });

  it('reads service.name from resource attributes', () => {
    const s = parseTraces(
      spanLine({ traceId: 'aa', spanId: '01' }, [
        { key: 'service.name', value: { stringValue: 'svc-a' } },
      ]),
    )[0]!;
    expect(s.service).toBe('svc-a');
  });
});

describe('parseLogs edge cases', () => {
  function logLine(record: Record<string, unknown>): string {
    return (
      JSON.stringify({
        resourceLogs: [
          {
            resource: { attributes: [{ key: 'service.name', value: { stringValue: 's' } }] },
            scopeLogs: [{ scope: {}, logRecords: [record] }],
          },
        ],
      }) + '\n'
    );
  }

  it('falls back to severityNumber when severityText is absent', () => {
    expect(parseLogs(logLine({ severityNumber: 17, body: { stringValue: 'x' } }))[0]!.level).toBe(
      'error',
    );
    expect(parseLogs(logLine({ severityNumber: 13, body: { stringValue: 'x' } }))[0]!.level).toBe(
      'warn',
    );
    expect(parseLogs(logLine({ body: { stringValue: 'x' } }))[0]!.level).toBe('info');
  });

  it('maps warning → warn', () => {
    expect(
      parseLogs(logLine({ severityText: 'WARNING', body: { stringValue: 'x' } }))[0]!.level,
    ).toBe('warn');
  });

  it('stringifies structured (kvlist) bodies instead of dropping them', () => {
    const body = { kvlistValue: { values: [{ key: 'a', value: { stringValue: 'b' } }] } };
    const l = parseLogs(logLine({ body }))[0]!;
    expect(l.body).toContain('kvlistValue');
  });

  it('uses observedTimeUnixNano when timeUnixNano is absent', () => {
    const l = parseLogs(
      logLine({ observedTimeUnixNano: '1700000000000000000', body: { stringValue: 'x' } }),
    )[0]!;
    expect(l.ts).toBe(1_700_000_000_000);
  });
});

describe('normalizeId', () => {
  it('passes hex through lowercased', () => {
    expect(normalizeId('0AF7651916CD43DD8448EB211C80319C')).toBe(TRACE_ID);
    expect(normalizeId(SPAN_ID)).toBe(SPAN_ID);
  });

  it('decodes base64-encoded ids (older proto3-JSON marshalers)', () => {
    const b64 = Buffer.from(SPAN_ID, 'hex').toString('base64');
    expect(normalizeId(b64)).toBe(SPAN_ID);
  });

  it('returns empty string for missing ids', () => {
    expect(normalizeId(undefined)).toBe('');
    expect(normalizeId('')).toBe('');
  });
});
