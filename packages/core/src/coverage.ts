import type { Span, CoverageInfo } from './types.js';

const isFrontendFile = (path: string): boolean =>
  path.endsWith('.tsx') || path.endsWith('.jsx') || path.endsWith('.vue');

export function computeCoverage(spans: Span[], changedFiles: string[]): CoverageInfo {
  const filesWithSpans = new Set<string>();
  for (const span of spans) {
    const filepath = span.attributes['code.filepath'];
    if (typeof filepath === 'string' && filepath.length > 0) filesWithSpans.add(filepath);
  }

  const hits: string[] = [];
  const misses: string[] = [];
  const warnings: string[] = [];

  for (const changed of changedFiles) {
    if (changed.includes('.spec.') || changed.includes('.test.')) continue;
    const hit = [...filesWithSpans].some((f) => f.endsWith(changed) || changed.endsWith(f));
    if (hit) hits.push(changed);
    else misses.push(changed);
  }

  const hasExecutionEvidence = spans.length > 0;
  const hasBackendMisses = misses.some((m) => !isFrontendFile(m));
  const attribution_limited = hasExecutionEvidence && hasBackendMisses;

  for (const miss of misses) {
    if (isFrontendFile(miss)) {
      warnings.push(`${miss}: frontend file, 0 spans expected`);
    } else if (hasExecutionEvidence) {
      warnings.push(
        `${miss}: backend file with no spans — likely an OpenTelemetry attribution gap (trace shows ${spans.length} spans), not a missed code path. Verify by asserting on the response body.`,
      );
    } else {
      warnings.push(`${miss}: backend file with no spans — change may not be exercised`);
    }
  }

  return { hits, misses, warnings, attribution_limited };
}
