import type { RawEvidence, EvidenceRef } from '../types.js';

export function collectTier1(evidence: RawEvidence): EvidenceRef[] {
  const refs: EvidenceRef[] = [];
  const t = evidence.test_summary;

  if (t.status === 'failed' || t.status === 'timedOut') {
    refs.push({
      kind: 'assertion',
      id: `assertion:${t.file}:${t.name}`,
      summary: `Test ${t.status}: ${t.name}${t.failure_message ? ` — ${t.failure_message}` : ''}`,
      data: t,
    });
  }

  for (const span of evidence.spans) {
    const code = Number(span.attributes['http.status_code']);
    const is5xx = Number.isFinite(code) && code >= 500;
    const isErr = span.status === 'ERROR';
    if (!isErr && !is5xx) continue;
    const label = isErr ? (is5xx ? `ERROR (HTTP ${code})` : 'ERROR') : `HTTP ${code}`;
    refs.push({
      kind: 'span',
      id: span.span_id,
      service: span.service,
      summary: `${label} span ${span.name} (${span.service}, ${span.duration_ms}ms)`,
      data: span,
    });
  }

  for (const log of evidence.logs) {
    if (log.level !== 'error' && log.level !== 'fatal') continue;
    refs.push({
      kind: 'log',
      id: `log:${log.service}:${log.ts}`,
      service: log.service,
      summary: `${log.level.toUpperCase()} ${log.service}: ${log.body.slice(0, 120)}`,
      data: log,
    });
  }

  for (const e of evidence.browser_events) {
    if (e.kind !== 'page_error') continue;
    const head = e.text ?? e.stack?.split('\n')[0] ?? 'unknown';
    refs.push({
      kind: 'browser_event',
      id: `browser:page_error:${e.ts}`,
      summary: `Browser page_error: ${head}`,
      data: e,
    });
  }

  return refs;
}
