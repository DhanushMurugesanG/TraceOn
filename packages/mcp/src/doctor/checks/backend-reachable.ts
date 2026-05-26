import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { CheckFn } from '../types.js';
import { fetchWithTimeout } from './_http.js';

/**
 * Check 4 — Backend reachable.
 *
 * Detects a backend URL from the most common sources (vite proxy config,
 * .env VITE_API_URL / API_URL, common localhost defaults). HEAD requests
 * the URL with a short timeout. Side effect: writes ctx.backendUrl for
 * the CORS check that follows.
 */

const COMMON_DEFAULTS = [
  'http://localhost:3001/api',
  'http://localhost:3000/api',
  'http://localhost:8000/api',
  'http://localhost:8080/api',
  'http://localhost:8000',
  'http://localhost:8080',
];

const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];

export function detectBackendUrl(projectRoot: string): string | undefined {
  // 1. vite.config.{ts,js,mjs} proxy entries
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
    const p = join(projectRoot, f);
    if (!existsSync(p)) continue;
    try {
      const src = readFileSync(p, 'utf-8');
      // Look for a `target: 'http://...'` inside a `proxy: { ... }` block
      const proxy = src.match(/proxy\s*:\s*\{([\s\S]*?)\n\s*\}/);
      if (proxy) {
        const target = proxy[1]!.match(/target\s*:\s*['"`]([^'"`]+)['"`]/);
        if (target) return target[1];
      }
    } catch { /* swallow */ }
  }

  // 2. .env files — VITE_API_URL or API_URL
  for (const f of ENV_FILES) {
    const p = join(projectRoot, f);
    if (!existsSync(p)) continue;
    try {
      const src = readFileSync(p, 'utf-8');
      const m = src.match(/^\s*(?:VITE_API_URL|API_URL)\s*=\s*['"]?(https?:\/\/[^\s'"]+)/m);
      if (m) return m[1];
    } catch { /* swallow */ }
  }

  // 3. Detect a packages/ workspace with a backend port hint (heuristic)
  // — skip in v1; the common defaults below cover the realistic cases.

  // 4. Try the common defaults — return the first that's set up to listen.
  //    We don't actually probe here (that's the next check), just return
  //    the most plausible URL.
  return undefined;
}

export const backendReachable: CheckFn = async (ctx) => {
  let backendUrl = detectBackendUrl(ctx.projectRoot);

  // If no explicit signal, try common defaults but PROBE each so we don't
  // print a misleading "found at http://localhost:3001" when nothing's there.
  if (!backendUrl) {
    for (const candidate of COMMON_DEFAULTS) {
      const r = await fetchWithTimeout(candidate, { method: 'HEAD', timeoutMs: 1500 });
      if (r.ok) { backendUrl = candidate; break; }
    }
  }

  if (!backendUrl) {
    return {
      name: 'Backend reachable',
      status: 'skip',
      message: 'Could not detect a backend URL',
      detail: 'Checked vite.config.* proxy, .env (VITE_API_URL / API_URL), and common localhost defaults — nothing matched.',
    };
  }

  ctx.backendUrl = backendUrl;

  const res = await fetchWithTimeout(backendUrl, { method: 'HEAD', timeoutMs: 3000 });
  if (res.ok) {
    return {
      name: `Backend reachable at ${backendUrl}`,
      status: 'pass',
      // Any response (even 4xx) means the server is alive.
      message: `Got HTTP ${res.status}`,
    };
  }

  return {
    name: 'Backend reachable',
    status: 'warn',
    message: `Could not reach ${backendUrl}`,
    detail: res.error,
    fix: 'Start your backend service before running traceon_verify.',
  };
};

// Allow tests to override the default list during fixture-driven runs.
export const _internal = { COMMON_DEFAULTS };
