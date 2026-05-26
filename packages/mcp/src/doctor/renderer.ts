import type { CheckResult, CheckStatus } from './types.js';

/**
 * Terminal renderer for doctor check results. Returns the formatted string
 * (single newline-separated block) — caller writes to stdout. Returning a
 * string instead of writing directly makes it trivially testable.
 *
 * Color + Unicode handling:
 *   - colors on iff `useColor === true`
 *   - Unicode icons iff `useUnicode === true`; otherwise ASCII labels
 *
 * The CLI entry point detects both from process.stdout.isTTY and the
 * platform and passes the booleans in; tests pass them explicitly.
 */

type Style = {
  /** ANSI prefix for this status (already empty when colors off). */
  ansi: string;
  /** Icon when Unicode enabled. */
  icon: string;
  /** ASCII fallback label. */
  ascii: string;
};

const RESET = '[0m';

function styleFor(status: CheckStatus, useColor: boolean): Style {
  // ANSI: 32 green, 31 red, 33 yellow, 90 bright black (gray)
  const wrap = (code: string, icon: string, ascii: string): Style => ({
    ansi: useColor ? `[${code}m` : '',
    icon,
    ascii,
  });
  switch (status) {
    case 'pass': return wrap('32', '✓', 'PASS');
    case 'fail': return wrap('31', '✗', 'FAIL');
    case 'warn': return wrap('33', '⚠', 'WARN');
    case 'skip': return wrap('90', '-', 'SKIP');
  }
}

function marker(style: Style, useUnicode: boolean): string {
  // Width-stable: Unicode glyphs print as 1 col, ASCII labels as 4. We pad
  // ASCII to 4 either way so check-name columns line up.
  if (useUnicode) return `${style.ansi}${style.icon}${style.ansi ? RESET : ''}`;
  return `${style.ansi}${style.ascii}${style.ansi ? RESET : ''}`;
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

export interface RenderOptions {
  useColor: boolean;
  useUnicode: boolean;
}

export function renderResult(result: CheckResult, opts: RenderOptions): string {
  const style = styleFor(result.status, opts.useColor);
  const tick = marker(style, opts.useUnicode);
  const lines: string[] = [`${tick} ${result.name}`];
  if (result.message && result.status !== 'pass') {
    // For non-pass, message duplicates the name in past tense — surface it.
    // For pass, name is enough and message would just be noise.
    if (result.message !== result.name) {
      lines.push(indent(result.message, '  '));
    }
  }
  if (result.detail) lines.push(indent(result.detail, '  '));
  if (result.fix) lines.push(indent(`Fix: ${result.fix}`, '  '));
  return lines.join('\n');
}

export function renderSummary(results: CheckResult[], opts: RenderOptions): string {
  const counts: Record<CheckStatus, number> = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const r of results) counts[r.status]++;
  const parts: string[] = [];
  if (counts.pass) parts.push(`${counts.pass} passed`);
  if (counts.fail) parts.push(colorize(`${counts.fail} failed`, '31', opts.useColor));
  if (counts.warn) parts.push(colorize(`${counts.warn} warned`, '33', opts.useColor));
  if (counts.skip) parts.push(`${counts.skip} skipped`);
  const line = parts.join(', ');
  if (counts.fail > 0) {
    return `\n${line}\n\nRun \`traceon doctor\` again after applying fixes.`;
  }
  if (counts.warn > 0) {
    return `\n${line}\n\nWarnings won't block traceon_verify but may surface as evidence noise.`;
  }
  return `\n${line}\n\nEverything looks good. Run \`traceon_verify\` to verify a change.`;
}

function colorize(text: string, code: string, useColor: boolean): string {
  return useColor ? `[${code}m${text}${RESET}` : text;
}

export function renderHeader(opts: RenderOptions): string {
  return opts.useColor
    ? `[1mRunning TraceOn doctor...${RESET}\n`
    : 'Running TraceOn doctor...\n';
}

export function renderAll(results: CheckResult[], opts: RenderOptions): string {
  const blocks = [renderHeader(opts)];
  for (const r of results) blocks.push(renderResult(r, opts));
  blocks.push(renderSummary(results, opts));
  return blocks.join('\n');
}
