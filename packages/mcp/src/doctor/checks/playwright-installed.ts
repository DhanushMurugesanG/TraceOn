import { existsSync } from 'fs';
import { join } from 'path';
import type { CheckFn } from '../types.js';

/**
 * Check 1 — Playwright is installed locally.
 *
 * Skips when there's no package.json in cwd (user probably ran doctor in
 * the wrong directory; failing here would be a false alarm).
 */
export const playwrightInstalled: CheckFn = async (ctx) => {
  if (!existsSync(join(ctx.projectRoot, 'package.json'))) {
    return {
      name: 'Playwright is installed',
      status: 'skip',
      message: 'No package.json in this directory',
      detail: `Run \`traceon doctor\` from inside a project (saw cwd=${ctx.cwd}).`,
    };
  }

  const binPath = join(ctx.projectRoot, 'node_modules', '.bin', 'playwright');
  if (existsSync(binPath)) {
    return {
      name: 'Playwright is installed',
      status: 'pass',
      message: 'Playwright binary present in node_modules/.bin',
    };
  }

  return {
    name: 'Playwright is installed',
    status: 'fail',
    message: 'Playwright binary not found',
    detail: `Expected at ${binPath}.`,
    fix: 'npm install --save-dev @playwright/test && npx playwright install chromium',
  };
};
