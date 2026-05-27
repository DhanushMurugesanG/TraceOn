import type { CheckFn } from '../types.js';
import { fetchWithTimeout } from './_http.js';

/**
 * Check 5 — Every detected backend allows the `traceparent` header.
 *
 * The single most valuable check in the doctor. Reproduces the browser's
 * preflight in miniature: OPTIONS with Access-Control-Request-Headers:
 * traceparent, then inspects the response's Access-Control-Allow-Headers
 * for the header. If absent, browsers will reject every request TraceOn's
 * fixture tries to inject the trace header into — the test will fail in
 * confusing ways without TraceOn ever seeing a backend span.
 *
 * v0.0.11 expansion: probes EVERY backend in ctx.backendUrls, not just
 * the first. Multi-backend apps (Trainery Core API + Review-cloud) need
 * each backend's CORS verified independently.
 */

const CORS_FIX = [
  'Add `traceparent` to each backend\'s Access-Control-Allow-Headers.',
  'Snippets:',
  '  gofiber:  AllowHeaders: "Origin, Content-Type, Authorization, traceparent, tracestate"',
  '  rs/cors:  AllowedHeaders: []string{"Authorization", "Content-Type", "traceparent", "tracestate"}',
  '  Node cors: allowedHeaders: ["Authorization", "Content-Type", "traceparent", "tracestate"]',
  '  FastAPI:  allow_headers=["Authorization", "Content-Type", "traceparent", "tracestate"]',
  'Full guide: docs/auth-and-cors-setup.md',
].join('\n');

export function allowsTraceparent(allowHeaders: string | null | undefined): boolean {
  if (!allowHeaders) return false;
  if (allowHeaders.trim() === '*') return true;
  return allowHeaders
    .toLowerCase()
    .split(',')
    .map((h) => h.trim())
    .includes('traceparent');
}

interface BackendResult {
  url: string;
  status: 'pass' | 'fail' | 'skip';
  allowHeaders?: string | null;
  error?: string;
}

async function probeOne(url: string, origin: string): Promise<BackendResult> {
  const res = await fetchWithTimeout(url, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'traceparent',
    },
    timeoutMs: 3000,
  });
  if (!res.ok) return { url, status: 'skip', error: res.error };
  const allow = res.headers.get('access-control-allow-headers');
  return { url, status: allowsTraceparent(allow) ? 'pass' : 'fail', allowHeaders: allow };
}

export const corsTraceparent: CheckFn = async (ctx) => {
  const urls = ctx.backendUrls ?? (ctx.backendUrl ? [ctx.backendUrl] : []);
  if (urls.length === 0) {
    return {
      name: 'CORS allows traceparent',
      status: 'skip',
      message: 'No backends detected — can\'t probe CORS',
    };
  }

  const origin = ctx.playwrightBaseUrl ?? 'http://localhost:5173';
  const results = await Promise.all(urls.map((u) => probeOne(u, origin)));

  const passed = results.filter((r) => r.status === 'pass');
  const failed = results.filter((r) => r.status === 'fail');
  const skipped = results.filter((r) => r.status === 'skip');

  if (failed.length === 0 && passed.length > 0) {
    return {
      name: `CORS allows traceparent (${passed.length} backend${passed.length === 1 ? '' : 's'})`,
      status: 'pass',
      message: passed.length === 1
        ? `${passed[0]!.url} allows traceparent in preflight`
        : passed.map((r) => `  ${r.url}: ✓ allowed`).join('\n'),
    };
  }

  if (failed.length === 0) {
    // All skipped (no response). Already reported by the backend-reachable
    // check; don't double-warn here.
    return {
      name: 'CORS allows traceparent',
      status: 'skip',
      message: 'No backends responded to OPTIONS preflight',
      detail: skipped.map((r) => `  ${r.url}: ${r.error ?? 'no response'}`).join('\n'),
    };
  }

  // At least one failure — name each backend's status so the user knows
  // exactly which to fix.
  const perBackend = results.map((r) => {
    if (r.status === 'pass') return `  ✓ ${r.url}: traceparent allowed`;
    if (r.status === 'fail') return `  ✗ ${r.url}: traceparent missing\n    ACAH: ${r.allowHeaders ?? '(missing)'}`;
    return `  - ${r.url}: did not respond (${r.error ?? 'unknown'})`;
  }).join('\n');

  return {
    name: `CORS allows traceparent (${passed.length} of ${passed.length + failed.length} pass)`,
    status: 'fail',
    message: `${failed.length} backend${failed.length === 1 ? '' : 's'} reject traceparent`,
    detail: `Probed with Origin: ${origin}.\n${perBackend}\n` +
      'Browser will block requests with the trace header injected against any failing backend, ' +
      'so verification will run without backend spans for those routes.',
    fix: CORS_FIX,
  };
};
