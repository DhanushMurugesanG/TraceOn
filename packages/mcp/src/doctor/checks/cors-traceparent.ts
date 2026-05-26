import type { CheckFn } from '../types.js';
import { fetchWithTimeout } from './_http.js';

/**
 * Check 5 — Backend CORS allows the `traceparent` header.
 *
 * The single most valuable check in the doctor. Reproduces the browser's
 * preflight in miniature: OPTIONS with Access-Control-Request-Headers:
 * traceparent, then inspects the response's Access-Control-Allow-Headers
 * for the header. If absent, browsers will reject every request TraceOn's
 * fixture tries to inject the trace header into — the test will fail in
 * confusing ways without TraceOn ever seeing a backend span.
 *
 * Skips when the backend wasn't detected or didn't respond in the
 * previous check.
 */

const CORS_FIX = [
  'Add `traceparent` to your backend\'s Access-Control-Allow-Headers.',
  'Snippets:',
  '  gofiber:  AllowHeaders: "Origin, Content-Type, Authorization, traceparent, tracestate"',
  '  rs/cors:  AllowedHeaders: []string{"Authorization", "Content-Type", "traceparent", "tracestate"}',
  '  Node cors: allowedHeaders: ["Authorization", "Content-Type", "traceparent", "tracestate"]',
  '  FastAPI:  allow_headers=["Authorization", "Content-Type", "traceparent", "tracestate"]',
  'Full guide: docs/auth-and-cors-setup.md',
].join('\n');

export function allowsTraceparent(allowHeaders: string | null | undefined): boolean {
  if (!allowHeaders) return false;
  // Wildcard allow-headers — accepts all custom headers
  if (allowHeaders.trim() === '*') return true;
  return allowHeaders
    .toLowerCase()
    .split(',')
    .map((h) => h.trim())
    .includes('traceparent');
}

export const corsTraceparent: CheckFn = async (ctx) => {
  if (!ctx.backendUrl) {
    return {
      name: 'CORS allows traceparent',
      status: 'skip',
      message: 'Backend was not detected — can\'t probe CORS',
    };
  }

  const origin = ctx.playwrightBaseUrl ?? 'http://localhost:5173';
  const res = await fetchWithTimeout(ctx.backendUrl, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'traceparent',
    },
    timeoutMs: 3000,
  });

  if (!res.ok) {
    return {
      name: 'CORS allows traceparent',
      status: 'skip',
      message: `Backend at ${ctx.backendUrl} did not respond to OPTIONS preflight`,
      detail: res.error,
    };
  }

  const allowHeaders = res.headers.get('access-control-allow-headers');
  if (allowsTraceparent(allowHeaders)) {
    return {
      name: 'CORS allows traceparent',
      status: 'pass',
      message: `${ctx.backendUrl} allows traceparent in preflight`,
    };
  }

  return {
    name: 'CORS allows traceparent',
    status: 'fail',
    message: 'traceparent is not in Access-Control-Allow-Headers',
    detail:
      `Probed ${ctx.backendUrl} with Origin: ${origin}.\n` +
      `Response Access-Control-Allow-Headers: ${allowHeaders ?? '(missing)'}.\n` +
      'Your backend will block the trace header TraceOn injects, so verification ' +
      'will run without backend spans.',
    fix: CORS_FIX,
  };
};
