import type { WaitForTraceOptions } from './interface.js';

/**
 * Settle defaults shared by every backend so the agent's experience doesn't
 * shift with the backend (plan risk register: "span-settle heuristic differs
 * from SigNoz's behavior"). One source of truth — do not re-declare per
 * backend.
 */
export const DEFAULT_WAIT: WaitForTraceOptions = {
  maxWaitMs: 60_000,
  stabilityMs: 10_000,
  pollMs: 2_000,
};

/** Unix nanoseconds (number or numeric string) → unix milliseconds. */
export function nanosToMs(value: unknown): number {
  if (typeof value === 'number') return Math.floor(value / 1_000_000);
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.floor(n / 1_000_000) : 0;
  }
  return 0;
}

/**
 * Normalize a raw HTTP status value onto `attributes['http.status_code']` as a
 * number. Shared so SigNoz and embedded classify status codes identically
 * (the ranker keys error severity off this).
 */
export function coerceHttpStatusCode(
  attributes: Record<string, string | number | boolean>,
  raw: unknown,
): void {
  if (typeof raw === 'number') attributes['http.status_code'] = raw;
  else if (typeof raw === 'string' && raw.length > 0 && Number.isFinite(Number(raw))) {
    attributes['http.status_code'] = Number(raw);
  }
}

/**
 * Shared trace-settle loop. Polls `getCount` every `pollMs`; declares the
 * trace settled once the count is unchanged for `stabilityMs`; gives up
 * (`complete: false`, not an error) at `maxWaitMs`. `checkAlive`, if given,
 * runs at the top of each iteration and may throw to abort the wait — the
 * embedded backend uses it to surface a dead collector instead of timing out.
 *
 * Single implementation so the two backends cannot drift apart.
 */
export async function waitForTraceSettle(
  getCount: () => number | Promise<number>,
  opts: WaitForTraceOptions,
  checkAlive?: () => void,
): Promise<{ complete: boolean }> {
  const start = Date.now();
  let lastCount = 0;
  let lastChangeAt = Date.now();

  while (Date.now() - start < opts.maxWaitMs) {
    if (checkAlive) checkAlive();
    const count = await getCount();
    if (count !== lastCount) {
      lastCount = count;
      lastChangeAt = Date.now();
    } else if (lastCount > 0 && Date.now() - lastChangeAt > opts.stabilityMs) {
      return { complete: true };
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
  return { complete: false };
}
