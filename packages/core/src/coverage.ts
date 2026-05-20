import type { Span, CoverageInfo } from './types.js';

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

  for (const miss of misses) {
    if (miss.endsWith('.tsx') || miss.endsWith('.jsx') || miss.endsWith('.vue')) {
      warnings.push(`${miss}: frontend file, 0 spans expected`);
    } else {
      warnings.push(`${miss}: backend file with no spans — change may not be exercised`);
    }
  }

  return { hits, misses, warnings };
}
