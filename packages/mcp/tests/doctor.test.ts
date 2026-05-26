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
    expect(r.detail!).toMatch(/Access-Control-Allow-Headers/);
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
