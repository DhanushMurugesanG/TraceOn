/**
 * Tests for v0.0.11's browser console event aggregation in Tier 2.
 *
 * The round-3 feedback called out 17 identical CORS errors landing as 17
 * separate Tier 2 entries, eating budget that should carry signal. The fix
 * groups by (level, normalized text) and emits one ref per group with `count`.
 */
import { describe, it, expect } from 'vitest';
import { rank } from '../src/ranker.js';
import type { RawEvidence, BrowserEvent } from '../src/types.js';

function makeEvidence(events: BrowserEvent[]): RawEvidence {
  return {
    run_id: 'r',
    trace_id: 't',
    test_summary: {
      file: 't.spec.ts', name: 't', status: 'passed', duration_ms: 1, steps_executed: [],
    },
    spans: [],
    logs: [],
    browser_events: events,
    coverage: { hits: [], misses: [], warnings: [], attribution_limited: false },
    changed_files: [],
    incomplete: false,
    no_trace_activity: false,
  };
}

function consoleErr(ts: number, text: string): BrowserEvent {
  return { kind: 'console', ts, level: 'error', text, attributes: {} };
}

describe('Tier 2 console-event aggregation (v0.0.11)', () => {
  it('collapses identical console errors into one ref with count', () => {
    // 17 byte-identical CORS errors — the exact case round-3 feedback hit.
    const events: BrowserEvent[] = [];
    for (let i = 0; i < 17; i++) {
      events.push(consoleErr(1000 + i, "Access to fetch at 'http://x/api' has been blocked by CORS policy"));
    }
    const result = rank(makeEvidence(events));
    const consoleRefs = result.tier2.filter((r) => r.kind === 'browser_event');
    expect(consoleRefs.length).toBe(1);
    expect(consoleRefs[0]!.count).toBe(17);
    expect(consoleRefs[0]!.summary).toMatch(/×17/);
    expect(consoleRefs[0]!.summary).toMatch(/Access to fetch/);
  });

  it('keeps singletons untouched (no count field, no ×1 in summary)', () => {
    const events = [consoleErr(1000, 'Just one error message')];
    const result = rank(makeEvidence(events));
    const consoleRefs = result.tier2.filter((r) => r.kind === 'browser_event');
    expect(consoleRefs.length).toBe(1);
    expect(consoleRefs[0]!.count).toBeUndefined();
    expect(consoleRefs[0]!.summary).not.toMatch(/×/);
  });

  it('does NOT collapse messages that differ even slightly (different URLs)', () => {
    const events = [
      consoleErr(1000, "Access to fetch at 'http://x/api/a' blocked by CORS"),
      consoleErr(2000, "Access to fetch at 'http://x/api/b' blocked by CORS"),
      consoleErr(3000, "Access to fetch at 'http://x/api/c' blocked by CORS"),
    ];
    const result = rank(makeEvidence(events));
    const consoleRefs = result.tier2.filter((r) => r.kind === 'browser_event');
    // Three distinct messages → three refs
    expect(consoleRefs.length).toBe(3);
    for (const r of consoleRefs) expect(r.count).toBeUndefined();
  });

  it('does NOT collapse across log levels (warn vs error stay separate)', () => {
    const events: BrowserEvent[] = [
      { kind: 'console', ts: 1000, level: 'error', text: 'same text', attributes: {} },
      { kind: 'console', ts: 2000, level: 'warn', text: 'same text', attributes: {} },
    ];
    const result = rank(makeEvidence(events));
    const consoleRefs = result.tier2.filter((r) => r.kind === 'browser_event');
    expect(consoleRefs.length).toBe(2);
  });

  it('handles mixed: some collapsing, some singletons', () => {
    const events: BrowserEvent[] = [
      consoleErr(1000, 'repeating CORS error'),
      consoleErr(1001, 'repeating CORS error'),
      consoleErr(1002, 'repeating CORS error'),
      consoleErr(2000, 'unique error'),
    ];
    const result = rank(makeEvidence(events));
    const consoleRefs = result.tier2.filter((r) => r.kind === 'browser_event');
    expect(consoleRefs.length).toBe(2);
    const grouped = consoleRefs.find((r) => r.count === 3);
    const single = consoleRefs.find((r) => r.count === undefined);
    expect(grouped?.summary).toMatch(/×3/);
    expect(single?.summary).toMatch(/unique error/);
  });

  it('aggregated ref preserves the first occurrence as data', () => {
    const events = [
      consoleErr(1000, 'msg'),
      consoleErr(2000, 'msg'),
    ];
    const result = rank(makeEvidence(events));
    const ref = result.tier2.find((r) => r.kind === 'browser_event')!;
    expect((ref.data as BrowserEvent).ts).toBe(1000);
  });
});
