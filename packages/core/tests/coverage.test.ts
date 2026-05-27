/**
 * Tests for computeCoverage().
 *
 * The v0.0.11 change: frontend files (`.tsx` / `.jsx` / `.vue` / `.svelte`
 * AND .ts/.js files under typical frontend `src/` paths) are dropped from
 * `coverage.misses` entirely and surfaced in a single `coverage.info` line
 * instead. The round-3 feedback called this round-trip out as friction —
 * the tool was emitting a warning it knew was bogus, forcing the agent to
 * consult the skill before ignoring it.
 */
import { describe, it, expect } from 'vitest';
import { computeCoverage } from '../src/coverage.js';
import type { Span } from '../src/types.js';

function span(opts: Partial<Span> & { code_filepath?: string }): Span {
  return {
    trace_id: 't',
    span_id: 's',
    parent_span_id: undefined,
    name: 'op',
    service: 'svc',
    start_ts: 0,
    duration_ms: 1,
    status: 'ok',
    attributes: opts.code_filepath
      ? { 'code.filepath': opts.code_filepath, ...(opts.attributes ?? {}) }
      : (opts.attributes ?? {}),
    ...opts,
  } as Span;
}

describe('computeCoverage — frontend files no longer warn (v0.0.11)', () => {
  it('drops .tsx files from misses entirely, summarises in info', () => {
    const r = computeCoverage([], [
      'src/components/Foo.tsx',
      'src/pages/Bar.tsx',
    ]);
    expect(r.misses).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.info).toBeDefined();
    expect(r.info!.length).toBe(1);
    expect(r.info![0]!).toMatch(/2 frontend files/);
    expect(r.info![0]!).toMatch(/Foo\.tsx/);
    expect(r.info![0]!).toMatch(/Bar\.tsx/);
  });

  it('handles .jsx, .vue, .svelte the same way', () => {
    const r = computeCoverage([], [
      'src/A.jsx',
      'src/B.vue',
      'src/C.svelte',
    ]);
    expect(r.misses).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.info![0]!).toMatch(/3 frontend files/);
  });

  it('catches .ts files under typical frontend src/ paths', () => {
    const r = computeCoverage([], [
      'packages/review-cloud/src/types/cycles-list.ts',
      'packages/shell-app/src/utils/tokenStorage.ts',
    ]);
    expect(r.misses).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.info![0]!).toMatch(/2 frontend files/);
  });

  it('still flags backend files in misses with attribution_limited reasoning', () => {
    // A trace with spans (execution evidence exists) plus a backend file
    // in changed_files that wasn't span-attributed.
    const spans = [span({ name: 'http GET /foo', service: 'api' })];
    const r = computeCoverage(spans, [
      'api/internal/services/cycle.go',
      'src/components/Foo.tsx', // frontend, should be filtered out
    ]);
    expect(r.misses).toEqual(['api/internal/services/cycle.go']);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]!).toMatch(/OpenTelemetry attribution gap/);
    expect(r.attribution_limited).toBe(true);
    // And the frontend file got its own info line:
    expect(r.info![0]!).toMatch(/Foo\.tsx/);
  });

  it('returns no info field when no frontend files were changed', () => {
    const r = computeCoverage([], ['api/handler.go']);
    expect(r.info).toBeUndefined();
  });

  it('grammar: 1 file uses singular', () => {
    const r = computeCoverage([], ['src/A.tsx']);
    expect(r.info![0]!).toMatch(/^1 frontend file /);
    // word-boundary check so "changed_files" doesn't false-match
    expect(r.info![0]!).not.toMatch(/frontend files/);
  });

  it('test files (.spec / .test) are ignored regardless of extension', () => {
    const r = computeCoverage([], [
      'src/Foo.spec.tsx',
      'tests/api.test.ts',
    ]);
    expect(r.misses).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.info).toBeUndefined();
  });
});
