import type { CheckFn } from '../types.js';
import { fetchWithTimeout } from './_http.js';

/**
 * Check 3 — Frontend baseURL responds.
 *
 * Skips when no baseURL was found in playwright.config.ts. We don't try
 * to guess (no defaults), because asking the user for "is your frontend
 * running" without knowing where would be noise.
 */
export const frontendReachable: CheckFn = async (ctx) => {
  const url = ctx.playwrightBaseUrl ?? ctx.playwrightWebServerUrl;
  if (!url) {
    return {
      name: 'Frontend reachable',
      status: 'skip',
      message: 'No baseURL or webServer.url found in Playwright config',
    };
  }

  const res = await fetchWithTimeout(url, { method: 'GET', timeoutMs: 3000 });
  if (res.ok) {
    return {
      name: `Frontend reachable at ${url}`,
      status: res.status >= 200 && res.status < 400 ? 'pass' : 'warn',
      message: `Got HTTP ${res.status}`,
    };
  }

  return {
    name: 'Frontend reachable',
    status: 'fail',
    message: `Could not reach ${url}`,
    detail: res.error,
    fix: 'Start your frontend dev server (e.g. `npm run dev`) before running traceon_verify.',
  };
};
