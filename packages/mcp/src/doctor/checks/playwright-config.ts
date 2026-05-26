import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { CheckFn } from '../types.js';

/**
 * Check 2 — Playwright config is parseable.
 *
 * Best-effort: extracts baseURL and webServer.url via regex (no TS/JS eval).
 * Side effect: writes discovered URLs to the shared DoctorContext so later
 * checks (frontend-reachable, CORS) can use them.
 */
const CONFIG_CANDIDATES = [
  'playwright.config.ts',
  'playwright.config.js',
  'playwright.config.mjs',
];

export function extractBaseUrl(source: string): string | undefined {
  const match = source.match(/baseURL\s*:\s*['"`]([^'"`]+)['"`]/);
  return match ? match[1] : undefined;
}

export function extractWebServerUrl(source: string): string | undefined {
  // Tolerant: looks for `url: 'http://...'` anywhere inside a `webServer: { ... }`
  // block. Works for the common shape; misses fancy nested configs.
  const ws = source.match(/webServer\s*:\s*\{([\s\S]*?)\}/);
  if (!ws) return undefined;
  const url = ws[1]!.match(/url\s*:\s*['"`]([^'"`]+)['"`]/);
  return url ? url[1] : undefined;
}

export const playwrightConfig: CheckFn = async (ctx) => {
  const configPath = CONFIG_CANDIDATES.map((f) => join(ctx.projectRoot, f)).find(existsSync);

  if (!configPath) {
    return {
      name: 'Playwright config is parseable',
      status: 'warn',
      message: 'No playwright.config.{ts,js,mjs} found',
      detail: 'TraceOn can still run tests without a config, but most projects want one.',
      fix: 'npx playwright init  (or write a minimal config by hand)',
    };
  }

  let source: string;
  try {
    source = readFileSync(configPath, 'utf-8');
  } catch (err) {
    return {
      name: 'Playwright config is parseable',
      status: 'fail',
      message: 'Could not read playwright config',
      detail: `${configPath} — ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (source.trim().length === 0) {
    return {
      name: 'Playwright config is parseable',
      status: 'fail',
      message: 'Playwright config is empty',
      detail: `${configPath} is zero-length.`,
    };
  }

  const baseUrl = extractBaseUrl(source);
  const webServerUrl = extractWebServerUrl(source);
  if (baseUrl) ctx.playwrightBaseUrl = baseUrl;
  if (webServerUrl) ctx.playwrightWebServerUrl = webServerUrl;

  return {
    name: 'Playwright config is parseable',
    status: 'pass',
    message: `Found ${configPath.replace(ctx.projectRoot + '/', '')}` +
      (baseUrl ? ` (baseURL=${baseUrl})` : ''),
  };
};
