/**
 * Tests for `traceon doctor`.
 *
 * Each test exercises a single check function in isolation with controlled
 * inputs (temp dirs, mocked fetch). The integration shape (runDoctor over
 * all 8) is covered separately via the renderer snapshot.
 *
 * Goal: enough coverage to catch regressions on the checks that have real
 * logic (CORS allow-headers parsing, playwright config extraction, fixture
 * presence). Skipping the network-bound checks that are essentially "call
 * fetch and report whatever came back" — testing them adds little signal
 * beyond what the type system gives us.
 */
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { playwrightInstalled } from '../src/doctor/checks/playwright-installed.js';
import {
  playwrightConfig,
  extractBaseUrl,
  extractWebServerUrl,
} from '../src/doctor/checks/playwright-config.js';
import {
  allowsTraceparent,
  corsTraceparent,
} from '../src/doctor/checks/cors-traceparent.js';
import { detectAllBackendUrls } from '../src/doctor/checks/backend-reachable.js';
import { renderResult, renderSummary, renderAll } from '../src/doctor/renderer.js';
import type { CheckResult, DoctorContext } from '../src/doctor/types.js';

const tmpDirs: string[] = [];
function mkProject(): string {
  const d = mkdtempSync(join(tmpdir(), 'traceon-doctor-test-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* swallow */ }
  }
  vi.unstubAllGlobals();
});

function emptyCtx(projectRoot: string): DoctorContext {
  return { cwd: projectRoot, projectRoot };
}

describe('playwrightInstalled check', () => {
  it('passes when the local Playwright binary exists', async () => {
    const root = mkProject();
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', '.bin', 'playwright'), '#!/bin/sh\n', { mode: 0o755 });

    const r = await playwrightInstalled(emptyCtx(root));
    expect(r.status).toBe('pass');
    expect(r.message).toMatch(/binary present/i);
  });

  it('fails with an actionable fix when Playwright is missing', async () => {
    const root = mkProject();
    writeFileSync(join(root, 'package.json'), '{}');
    // no node_modules

    const r = await playwrightInstalled(emptyCtx(root));
    expect(r.status).toBe('fail');
    expect(r.fix!).toMatch(/npm install --save-dev @playwright\/test/);
    expect(r.fix!).toMatch(/playwright install chromium/);
  });

  it('skips (does NOT fail) when there is no package.json — wrong directory', async () => {
    const root = mkProject();
    // no package.json at all

    const r = await playwrightInstalled(emptyCtx(root));
    expect(r.status).toBe('skip');
  });
});

describe('playwright config extraction', () => {
  it('extractBaseUrl finds baseURL in a typical config', () => {
    const src = `
      export default defineConfig({
        use: { baseURL: 'http://localhost:5173' },
      });
    `;
    expect(extractBaseUrl(src)).toBe('http://localhost:5173');
  });

  it('extractWebServerUrl finds url inside webServer block', () => {
    const src = `
      export default defineConfig({
        webServer: {
          command: 'npm run dev',
          url: 'http://127.0.0.1:3000',
          reuseExistingServer: true,
        },
      });
    `;
    expect(extractWebServerUrl(src)).toBe('http://127.0.0.1:3000');
  });

  it('returns undefined when patterns are absent', () => {
    expect(extractBaseUrl('// nothing')).toBeUndefined();
    expect(extractWebServerUrl('// nothing')).toBeUndefined();
  });

  it('full check populates ctx.playwrightBaseUrl on a valid config', async () => {
    const root = mkProject();
    writeFileSync(
      join(root, 'playwright.config.ts'),
      `export default { use: { baseURL: 'http://localhost:5173' } };`,
    );

    const ctx = emptyCtx(root);
    const r = await playwrightConfig(ctx);
    expect(r.status).toBe('pass');
    expect(ctx.playwrightBaseUrl).toBe('http://localhost:5173');
  });

  it('warns (does NOT fail) when no playwright.config.* is present', async () => {
    const root = mkProject();
    const r = await playwrightConfig(emptyCtx(root));
    expect(r.status).toBe('warn');
    expect(r.fix).toMatch(/playwright init/);
  });

  it('fails when the config exists but is empty', async () => {
    const root = mkProject();
    writeFileSync(join(root, 'playwright.config.ts'), '');
    const r = await playwrightConfig(emptyCtx(root));
    expect(r.status).toBe('fail');
    expect(r.message).toMatch(/empty/i);
  });
});

describe('allowsTraceparent — CORS allow-headers parsing', () => {
  it('matches traceparent in a comma-separated list, case-insensitive', () => {
    expect(allowsTraceparent('Content-Type, Authorization, traceparent')).toBe(true);
    expect(allowsTraceparent('Content-Type, Authorization, TraceParent')).toBe(true);
    expect(allowsTraceparent('Content-Type, Authorization, TRACEPARENT')).toBe(true);
  });

  it('returns true for wildcard allow-headers', () => {
    expect(allowsTraceparent('*')).toBe(true);
    expect(allowsTraceparent(' * ')).toBe(true);
  });

  it('returns false when traceparent is missing', () => {
    expect(allowsTraceparent('Content-Type, Authorization')).toBe(false);
    expect(allowsTraceparent('')).toBe(false);
    expect(allowsTraceparent(null)).toBe(false);
    expect(allowsTraceparent(undefined)).toBe(false);
  });

  it('does not match a header that merely contains "traceparent" as a substring', () => {
    expect(allowsTraceparent('X-MyTraceParentHeader')).toBe(false);
  });
});

describe('corsTraceparent — preflight probe', () => {
  beforeEach(() => {
    // Mock global fetch so we don't actually hit the network.
    vi.stubGlobal('fetch', vi.fn());
  });

  function mockFetch(allowHeaders: string | null) {
    const headers = new Headers();
    if (allowHeaders != null) headers.set('access-control-allow-headers', allowHeaders);
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 204,
      headers,
    } as unknown as Response);
  }

  it('skips when backendUrl was never discovered', async () => {
    const ctx = { cwd: '/x', projectRoot: '/x' } as DoctorContext;
    const r = await corsTraceparent(ctx);
    expect(r.status).toBe('skip');
  });

  it('passes when backend allows traceparent', async () => {
    mockFetch('Content-Type, Authorization, traceparent');
    const ctx = {
      cwd: '/x', projectRoot: '/x',
      backendUrl: 'http://localhost:3001',
    } as DoctorContext;
    const r = await corsTraceparent(ctx);
    expect(r.status).toBe('pass');
  });

  it('fails with CORS fix snippets when backend rejects traceparent', async () => {
    mockFetch('Content-Type, Authorization');
    const ctx = {
      cwd: '/x', projectRoot: '/x',
      backendUrl: 'http://localhost:3001',
    } as DoctorContext;
    const r = await corsTraceparent(ctx);
    expect(r.status).toBe('fail');
    expect(r.fix!).toMatch(/gofiber/);
    expect(r.fix!).toMatch(/rs\/cors/);
    expect(r.fix!).toMatch(/FastAPI/);
    // v0.0.11 multi-backend format: per-backend lines with "ACAH:" prefix.
    expect(r.detail!).toMatch(/ACAH:/);
    expect(r.detail!).toMatch(/Content-Type, Authorization/);
  });
});

describe('renderer', () => {
  const passResult: CheckResult = {
    name: 'Foo',
    status: 'pass',
    message: 'fine',
  };
  const failResult: CheckResult = {
    name: 'CORS allows traceparent',
    status: 'fail',
    message: 'traceparent missing',
    detail: 'Probed http://localhost:3001',
    fix: 'Add traceparent to Access-Control-Allow-Headers',
  };

  it('renders a pass result with just the name (no indented body)', () => {
    const out = renderResult(passResult, { useColor: false, useUnicode: true });
    expect(out).toBe('✓ Foo');
  });

  it('renders a fail result with message, detail, and Fix line', () => {
    const out = renderResult(failResult, { useColor: false, useUnicode: true });
    expect(out).toMatch(/^✗ CORS allows traceparent\n/);
    expect(out).toMatch(/  traceparent missing/);
    expect(out).toMatch(/  Probed http:\/\/localhost:3001/);
    expect(out).toMatch(/  Fix: Add traceparent to Access-Control-Allow-Headers/);
  });

  it('falls back to ASCII labels when useUnicode is false', () => {
    const out = renderResult(passResult, { useColor: false, useUnicode: false });
    expect(out.startsWith('PASS ')).toBe(true);
  });

  it('skips ANSI codes when useColor is false', () => {
    const out = renderResult(failResult, { useColor: false, useUnicode: true });
    expect(out).not.toMatch(/\[\d+m/);
  });

  it('renderSummary tells the user to re-run when any check failed', () => {
    const out = renderSummary([passResult, failResult], { useColor: false, useUnicode: true });
    expect(out).toMatch(/1 passed/);
    expect(out).toMatch(/1 failed/);
    expect(out).toMatch(/Run `traceon doctor` again/);
  });

  it('renderAll combines header + checks + summary in order', () => {
    const out = renderAll([passResult, failResult], { useColor: false, useUnicode: true });
    expect(out).toMatch(/^Running TraceOn doctor\.\.\./);
    const passIdx = out.indexOf('✓ Foo');
    const failIdx = out.indexOf('✗ CORS');
    const summaryIdx = out.indexOf('1 passed');
    expect(passIdx).toBeLessThan(failIdx);
    expect(failIdx).toBeLessThan(summaryIdx);
  });
});

// v0.0.11 — multi-backend doctor probe. Real apps (Trainery Core API at
// :8000 + Review-cloud at :8001) need every backend's CORS verified
// independently or the doctor gives false confidence.
describe('detectAllBackendUrls — finds every distinct backend (v0.0.11)', () => {
  it('returns every target in vite.config proxy, not just the first', () => {
    const root = mkProject();
    writeFileSync(join(root, 'vite.config.ts'), `
      export default defineConfig({
        server: {
          proxy: {
            '/api/core': { target: 'http://localhost:8000', changeOrigin: true },
            '/api/reviews': { target: 'http://localhost:8001', changeOrigin: true },
            '/api/auth': { target: 'http://localhost:9000', changeOrigin: true },
          },
        },
      });
    `);
    const urls = detectAllBackendUrls(root);
    expect(urls).toEqual([
      'http://localhost:8000',
      'http://localhost:8001',
      'http://localhost:9000',
    ]);
  });

  it('dedupes by origin + first path segment so /api and /api/health collapse', () => {
    const root = mkProject();
    writeFileSync(join(root, 'vite.config.ts'), `
      proxy: {
        target: 'http://localhost:8000/api',
        target: 'http://localhost:8000/api/health',
        target: 'http://localhost:9000/api',
      }
    `);
    const urls = detectAllBackendUrls(root);
    // Two distinct logical backends — :8000/api and :9000/api
    expect(urls.length).toBe(2);
    expect(urls.some((u) => u.startsWith('http://localhost:8000'))).toBe(true);
    expect(urls.some((u) => u.startsWith('http://localhost:9000'))).toBe(true);
  });

  it('combines vite proxy + .env *_API_URL into one list', () => {
    const root = mkProject();
    writeFileSync(join(root, 'vite.config.ts'),
      `proxy: { target: 'http://localhost:8000' }`,
    );
    writeFileSync(join(root, '.env'),
      'VITE_REVIEW_CLOUD_API_URL=http://localhost:8001\n' +
      'VITE_CORE_API_URL=http://localhost:8000\n' +  // duplicate, collapses
      'API_URL=http://localhost:9000\n',
    );
    const urls = detectAllBackendUrls(root);
    expect(urls.length).toBe(3); // 8000 (already there), 8001, 9000
    expect(urls).toContain('http://localhost:8001');
    expect(urls).toContain('http://localhost:9000');
  });

  it('returns [] when no config found anywhere', () => {
    const root = mkProject();
    expect(detectAllBackendUrls(root)).toEqual([]);
  });
});

describe('corsTraceparent — multi-backend (v0.0.11)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('passes when ALL backends in backendUrls allow traceparent', async () => {
    const headers = new Headers();
    headers.set('access-control-allow-headers', 'traceparent, Authorization');
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: 204, headers,
    } as unknown as Response);

    const ctx = {
      cwd: '/x', projectRoot: '/x',
      backendUrls: ['http://localhost:8000', 'http://localhost:8001'],
    } as DoctorContext;
    const r = await corsTraceparent(ctx);
    expect(r.status).toBe('pass');
    expect(r.name).toMatch(/2 backends/);
  });

  it('fails when ANY backend rejects traceparent, names each one', async () => {
    let call = 0;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(() => {
      const headers = new Headers();
      // First backend allows, second doesn't
      headers.set('access-control-allow-headers',
        call++ === 0 ? 'traceparent, Authorization' : 'Authorization');
      return Promise.resolve({ status: 204, headers } as unknown as Response);
    });

    const ctx = {
      cwd: '/x', projectRoot: '/x',
      backendUrls: ['http://localhost:8001', 'http://localhost:8000'],
    } as DoctorContext;
    const r = await corsTraceparent(ctx);
    expect(r.status).toBe('fail');
    expect(r.detail!).toMatch(/http:\/\/localhost:8000/); // the failing one is named
    expect(r.detail!).toMatch(/http:\/\/localhost:8001/); // the passing one is also shown for context
    expect(r.fix!).toMatch(/gofiber/);
  });
});
