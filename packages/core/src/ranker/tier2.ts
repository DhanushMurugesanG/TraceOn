import type { RawEvidence, EvidenceRef, Span, BrowserEvent } from '../types.js';

export interface Tier2Candidate {
  ref: EvidenceRef;
  category: 0 | 1 | 2 | 3; // 0=error-adjacent, 1=warning, 2=slow, 3=console_error
  ts: number;
}

const spanRef = (s: Span, summary: string): EvidenceRef => ({
  kind: 'span',
  id: s.span_id,
  service: s.service,
  summary,
  data: s,
});

function p95PerService(spans: Span[]): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const s of spans) {
    const arr = groups.get(s.service) ?? [];
    arr.push(s.duration_ms);
    groups.set(s.service, arr);
  }
  const out = new Map<string, number>();
  for (const [svc, arr] of groups) {
    arr.sort((a, b) => a - b);
    if (arr.length === 0) continue;
    out.set(svc, arr[Math.min(Math.floor(arr.length * 0.95), arr.length - 1)]!);
  }
  return out;
}

export function collectTier2(evidence: RawEvidence, tier1Ids: Set<string>): Tier2Candidate[] {
  const out: Tier2Candidate[] = [];
  const seen = new Set<string>();
  const add = (c: Tier2Candidate) => {
    if (tier1Ids.has(c.ref.id) || seen.has(c.ref.id)) return;
    seen.add(c.ref.id);
    out.push(c);
  };

  for (const log of evidence.logs) {
    if (log.level !== 'warn') continue;
    add({
      ref: {
        kind: 'log',
        id: `log:${log.service}:${log.ts}`,
        service: log.service,
        summary: `WARN ${log.service}: ${log.body.slice(0, 120)}`,
        data: log,
      },
      category: 1,
      ts: log.ts,
    });
  }

  const p95 = p95PerService(evidence.spans);
  for (const span of evidence.spans) {
    const threshold = p95.get(span.service);
    if (threshold === undefined || span.duration_ms <= threshold || span.duration_ms <= 0) continue;
    add({
      ref: spanRef(span, `Slow span ${span.name} (${span.service}, ${span.duration_ms}ms, p95=${threshold}ms)`),
      category: 2,
      ts: span.start_ts,
    });
  }

  for (const e of evidence.browser_events) {
    if (e.kind !== 'console' || (e.level !== 'warn' && e.level !== 'error')) continue;
    add({
      ref: {
        kind: 'browser_event',
        id: `browser:console:${e.ts}`,
        summary: `Console ${e.level}: ${(e.text ?? '').slice(0, 120)}`,
        data: e,
      },
      category: e.level === 'error' ? 3 : 1,
      ts: e.ts,
    });
  }

  const spanById = new Map(evidence.spans.map((s) => [s.span_id, s]));
  for (const id of tier1Ids) {
    const span = spanById.get(id);
    if (!span) continue;
    const parent = span.parent_span_id ? spanById.get(span.parent_span_id) : undefined;
    if (parent) {
      add({
        ref: spanRef(parent, `Parent of error span: ${parent.name} (${parent.service}, ${parent.duration_ms}ms)`),
        category: 0,
        ts: parent.start_ts,
      });
    }
    for (const child of evidence.spans) {
      if (child.parent_span_id !== id) continue;
      add({
        ref: spanRef(child, `Child of error span: ${child.name} (${child.service}, ${child.duration_ms}ms)`),
        category: 0,
        ts: child.start_ts,
      });
    }
  }

  return aggregateConsoleEvents(out);
}

/**
 * Browser console events frequently repeat identically — e.g. 17 verbatim
 * CORS errors as the page retries the same fetch. Each one was being
 * surfaced as a separate Tier 2 entry, which the agent skims past after
 * recognising the pattern. Worse, they eat budget that would otherwise
 * carry a more useful signal.
 *
 * Group console events by (level, normalized text). When the same text
 * appears more than once, collapse into a single ref with `count` set and
 * the summary annotated. Spans and logs are untouched.
 *
 * Normalization: just trim. We don't strip URLs / IDs / timestamps because
 * if those differ between occurrences, the messages are conceptually
 * different and should NOT collapse. The case round-3 feedback called out
 * was byte-identical messages, which trim-only handles correctly.
 */
export function aggregateConsoleEvents(candidates: Tier2Candidate[]): Tier2Candidate[] {
  const groups = new Map<string, Tier2Candidate[]>();
  const passthrough: Tier2Candidate[] = [];

  for (const c of candidates) {
    if (c.ref.kind !== 'browser_event') { passthrough.push(c); continue; }
    const ev = c.ref.data as BrowserEvent;
    if (ev.kind !== 'console') { passthrough.push(c); continue; }
    const key = `${ev.level}|${(ev.text ?? '').trim()}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }

  const aggregated: Tier2Candidate[] = [];
  for (const arr of groups.values()) {
    if (arr.length === 1) {
      aggregated.push(arr[0]!);
      continue;
    }
    const first = arr[0]!;
    const ev = first.ref.data as BrowserEvent;
    const text = (ev.text ?? '').slice(0, 120);
    aggregated.push({
      ...first,
      ref: {
        ...first.ref,
        // Make the ID stable but distinguishable from the singleton case
        id: `${first.ref.id}+${arr.length - 1}more`,
        count: arr.length,
        summary: `Console ${ev.level} (×${arr.length}): ${text}`,
      },
    });
  }

  return [...passthrough, ...aggregated];
}

export function sortTier2(items: Tier2Candidate[]): Tier2Candidate[] {
  return [...items].sort((a, b) => (a.category !== b.category ? a.category - b.category : a.ts - b.ts));
}
