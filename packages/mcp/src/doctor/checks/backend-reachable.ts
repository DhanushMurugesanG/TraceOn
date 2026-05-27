import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { CheckFn } from '../types.js';
import { fetchWithTimeout } from './_http.js';

/**
 * Check 4 — All backends reachable.
 *
 * Detects EVERY distinct backend URL from the most common sources
 * (all vite.config proxy entries, all *_API_URL env vars, common
 * localhost defaults). HEADs each with a short timeout. Side effect:
 * writes ctx.backendUrls (full list) and ctx.backendUrl (first one,
 * kept for back-compat with any external callers).
 *
 * v0.0.11 expansion: pre-v0.0.11 this returned the first hit only.
 * Real apps (Trainery Core API at :8000, Review-cloud at :8001) need
 * EVERY backend checked or the CORS probe gives false confidence.
 */

// 8080 is intentionally excluded — that's SigNoz's default on dev machines,
// and the doctor was treating it as a backend, producing a false "CORS
// rejects traceparent" failure against the SigNoz UI server. Real backends
// at :8080 (Spring Boot defaults etc.) have vite proxy or .env entries
// that the explicit-detect path picks up — the fallback list is for the
// "no config anywhere" case where SigNoz-on-:8080 is the most likely
// false-positive.
const COMMON_DEFAULTS = [
  'http://localhost:3001/api',
  'http://localhost:3000/api',
  'http://localhost:8000/api',
  'http://localhost:8000',
];

const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local'];

/** Normalize to origin + first path segment so http://x:1/api and
 *  http://x:1/api/health collapse into one logical backend. Keeps the
 *  origin so different ports stay distinct. */
function originAndApiPrefix(url: string): string {
  try {
    const u = new URL(url);
    // Keep the first path segment if it exists ("/api"), otherwise root.
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return `${u.origin}${seg ? `/${seg}` : ''}`;
  } catch {
    return url;
  }
}

/**
 * Pulls every distinct backend URL out of the project root. Exported
 * for tests so we can drive it with controlled fixture directories.
 */
export function detectAllBackendUrls(projectRoot: string): string[] {
  const found: string[] = [];

  // 1. vite.config.{ts,js,mjs} — ALL proxy targets, not just the first
  for (const f of ['vite.config.ts', 'vite.config.js', 'vite.config.mjs']) {
    const p = join(projectRoot, f);
    if (!existsSync(p)) continue;
    try {
      const src = readFileSync(p, 'utf-8');
      // Find every `target: 'http://...'` regardless of nesting depth.
      // The regex is intentionally loose — captures all targets in any
      // proxy block, not just the immediate one.
      const re = /target\s*:\s*['"`](https?:\/\/[^'"`]+)['"`]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) found.push(m[1]!);
    } catch { /* swallow */ }
  }

  // 2. .env files — every *_API_URL or API_URL value
  for (const f of ENV_FILES) {
    const p = join(projectRoot, f);
    if (!existsSync(p)) continue;
    try {
      const src = readFileSync(p, 'utf-8');
      const re = /^\s*(?:VITE_[A-Z_]*API[A-Z_]*URL|[A-Z_]*API[A-Z_]*URL)\s*=\s*['"]?(https?:\/\/[^\s'"]+)/gm;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) found.push(m[1]!);
    } catch { /* swallow */ }
  }

  // Dedupe by origin+first-path-segment so /api and /api/health collapse.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of found) {
    const key = originAndApiPrefix(url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

export const backendReachable: CheckFn = async (ctx) => {
  let urls = detectAllBackendUrls(ctx.projectRoot);

  if (urls.length === 0) {
    // Fall back to probing common defaults — same behaviour as pre-v0.0.11.
    const hits: string[] = [];
    for (const candidate of COMMON_DEFAULTS) {
      const r = await fetchWithTimeout(candidate, { method: 'HEAD', timeoutMs: 1500 });
      if (r.ok) hits.push(candidate);
    }
    urls = hits;
  }

  if (urls.length === 0) {
    return {
      name: 'Backend reachable',
      status: 'skip',
      message: 'Could not detect any backend URL',
      detail: 'Checked vite.config.* proxy, .env (VITE_*_API_URL / *_API_URL), and common localhost defaults — nothing matched.',
    };
  }

  // Probe each detected backend. The CORS check that runs after this
  // iterates the same list, so write all of them to context.
  const probed: Array<{ url: string; ok: boolean; status: number; error?: string }> = [];
  for (const url of urls) {
    const r = await fetchWithTimeout(url, { method: 'HEAD', timeoutMs: 3000 });
    probed.push({ url, ok: r.ok, status: r.status, error: r.error });
  }

  const reachable = probed.filter((p) => p.ok).map((p) => p.url);
  ctx.backendUrls = reachable;
  ctx.backendUrl = reachable[0]; // back-compat

  const failed = probed.filter((p) => !p.ok);
  if (reachable.length === 0) {
    return {
      name: 'Backend reachable',
      status: 'warn',
      message: `Detected ${probed.length} backend URL(s) but none responded`,
      detail: probed.map((p) => `  ${p.url}  ${p.error ?? `HTTP ${p.status}`}`).join('\n'),
      fix: 'Start your backend service(s) before running traceon_verify.',
    };
  }

  if (failed.length === 0) {
    return {
      name: `Backends reachable (${reachable.length} detected)`,
      status: 'pass',
      message: reachable.length === 1
        ? `${reachable[0]}: HTTP ${probed[0]!.status}`
        : probed.map((p) => `  ${p.url}: HTTP ${p.status}`).join('\n'),
    };
  }

  // Some reachable, some not — pass with detail since the CORS check
  // can still probe the reachable ones.
  return {
    name: `Backends reachable (${reachable.length} of ${probed.length})`,
    status: 'warn',
    message: 'Some backends did not respond',
    detail: probed
      .map((p) => `  ${p.url}: ${p.ok ? `HTTP ${p.status}` : (p.error ?? `HTTP ${p.status}`)}`)
      .join('\n'),
  };
};

// Allow tests to override the default list during fixture-driven runs.
export const _internal = { COMMON_DEFAULTS, originAndApiPrefix };
