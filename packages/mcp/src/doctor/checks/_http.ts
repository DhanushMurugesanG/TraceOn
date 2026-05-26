/**
 * Tiny HTTP helper for doctor checks. Wraps Node's built-in fetch with a
 * timeout and uniform success/failure shape so checks don't all reinvent
 * error handling.
 */

export interface HttpResult {
  ok: boolean;
  status: number;
  headers: Headers;
  /** Filled when ok is false — human-readable cause. */
  error?: string;
}

interface HttpOpts {
  method?: 'GET' | 'HEAD' | 'OPTIONS' | 'POST';
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export async function fetchWithTimeout(url: string, opts: HttpOpts = {}): Promise<HttpResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 3000);
  try {
    const res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: opts.headers,
      signal: controller.signal,
    });
    return { ok: true, status: res.status, headers: res.headers };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const tag = controller.signal.aborted
      ? `Timed out after ${opts.timeoutMs ?? 3000}ms`
      : message;
    return { ok: false, status: 0, headers: new Headers(), error: tag };
  } finally {
    clearTimeout(timer);
  }
}
