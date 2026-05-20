import type { RawEvidence } from '../types.js';

export function summarizeTier3(
  evidence: RawEvidence,
  excludedIds: Set<string>,
  cap: number,
): string {
  const parts: string[] = [];

  // Info-tier logs by service
  const infoLogsByService = new Map<string, number>();
  for (const log of evidence.logs) {
    if (log.level !== 'info' && log.level !== 'debug' && log.level !== 'trace') continue;
    if (excludedIds.has(`log:${log.service}:${log.ts}`)) continue;
    infoLogsByService.set(log.service, (infoLogsByService.get(log.service) ?? 0) + 1);
  }
  if (infoLogsByService.size > 0) {
    const breakdown = [...infoLogsByService.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([s, n]) => `${s}=${n}`)
      .join(', ');
    parts.push(`Info logs: ${breakdown}`);
  }

  // OK spans + successful HTTP requests
  let okSpans = 0;
  let httpOk = 0;
  for (const span of evidence.spans) {
    if (excludedIds.has(span.span_id)) continue;
    if (span.status === 'OK' || span.status === 'UNSET') okSpans++;
    const codeAttr = span.attributes['http.status_code'];
    const code = typeof codeAttr === 'number' ? codeAttr : Number(codeAttr);
    if (Number.isFinite(code) && code >= 200 && code < 400) httpOk++;
  }
  if (okSpans > 0) parts.push(`OK spans: ${okSpans}`);
  if (httpOk > 0) parts.push(`Successful HTTP requests: ${httpOk}`);

  // Notable patterns
  let cacheMisses = 0;
  for (const log of evidence.logs) {
    if (log.body.toLowerCase().includes('cache miss')) cacheMisses++;
  }
  if (cacheMisses > 10) parts.push(`Many cache misses (${cacheMisses})`);

  let summary = parts.length === 0 ? 'No additional context.' : parts.join('. ') + '.';

  const maxChars = cap * 4;
  if (summary.length > maxChars) summary = summary.slice(0, Math.max(0, maxChars - 3)) + '...';
  return summary;
}
