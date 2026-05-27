import type { Span, CoverageInfo } from './types.js';

const FRONTEND_EXT = ['.tsx', '.jsx', '.vue', '.svelte'];

const isFrontendFile = (path: string): boolean => {
  // Extension match catches .tsx / .jsx / .vue / .svelte directly.
  if (FRONTEND_EXT.some((ext) => path.endsWith(ext))) return true;
  // Path-pattern match catches .ts/.js files that live under a typical
  // frontend source directory. We're intentionally conservative — these
  // are paths where backend spans aren't expected even if the extension
  // is ambiguous.
  return /(^|\/)(packages\/[^/]*(frontend|client|web|ui|review-cloud|shell-app)[^/]*\/src\/|frontend\/src\/|client\/src\/|web\/src\/|app\/src\/)/.test(path);
};

export function computeCoverage(spans: Span[], changedFiles: string[]): CoverageInfo {
  const filesWithSpans = new Set<string>();
  for (const span of spans) {
    const filepath = span.attributes['code.filepath'];
    if (typeof filepath === 'string' && filepath.length > 0) filesWithSpans.add(filepath);
  }

  const hits: string[] = [];
  const misses: string[] = [];
  const warnings: string[] = [];
  const info: string[] = [];
  // Track frontend changed files for the single info summary line at the end.
  // Going to misses + warnings would force the agent through the skill's
  // "is this OK?" branch every time — round-3 feedback explicitly called out
  // this round-trip as friction. Frontend files don't produce backend spans,
  // so we drop them from misses entirely and emit one info line instead.
  const frontendChanged: string[] = [];

  for (const changed of changedFiles) {
    if (changed.includes('.spec.') || changed.includes('.test.')) continue;
    if (isFrontendFile(changed)) {
      frontendChanged.push(changed);
      continue;
    }
    const hit = [...filesWithSpans].some((f) => f.endsWith(changed) || changed.endsWith(f));
    if (hit) hits.push(changed);
    else misses.push(changed);
  }

  const hasExecutionEvidence = spans.length > 0;
  const attribution_limited = hasExecutionEvidence && misses.length > 0;

  for (const miss of misses) {
    if (hasExecutionEvidence) {
      warnings.push(
        `${miss}: backend file with no spans — likely an OpenTelemetry attribution gap (trace shows ${spans.length} spans), not a missed code path. Verify by asserting on the response body.`,
      );
    } else {
      warnings.push(`${miss}: backend file with no spans — change may not be exercised`);
    }
  }

  if (frontendChanged.length > 0) {
    // Single info line, plural-aware, lists the files so the agent has the
    // full picture without per-file warnings.
    info.push(
      `${frontendChanged.length} frontend file${frontendChanged.length === 1 ? '' : 's'} ` +
      `in changed_files (no backend spans expected): ` +
      frontendChanged.join(', '),
    );
  }

  const result: CoverageInfo = { hits, misses, warnings, attribution_limited };
  if (info.length > 0) result.info = info;
  return result;
}
