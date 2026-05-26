import { findProjectRoot } from '../playwright.js';
import { join } from 'path';
import { existsSync } from 'fs';
import type { CheckFn, CheckResult, DoctorContext } from './types.js';
import { renderAll } from './renderer.js';

import { playwrightInstalled } from './checks/playwright-installed.js';
import { playwrightConfig } from './checks/playwright-config.js';
import { frontendReachable } from './checks/frontend-reachable.js';
import { backendReachable } from './checks/backend-reachable.js';
import { corsTraceparent } from './checks/cors-traceparent.js';
import { signozReachable } from './checks/signoz-reachable.js';
import { mcpRegistered } from './checks/mcp-registered.js';
import { skillUpToDate } from './checks/skill-up-to-date.js';

// Order matters: earlier checks populate the shared context that later
// checks read from. Don't reorder without tracing the data flow.
const CHECKS: CheckFn[] = [
  playwrightInstalled,
  playwrightConfig,    // populates baseUrl, webServerUrl
  frontendReachable,   // reads baseUrl
  backendReachable,    // populates backendUrl
  corsTraceparent,     // reads backendUrl
  signozReachable,     // populates signozBaseUrl
  mcpRegistered,
  skillUpToDate,
];

export interface RunDoctorOptions {
  cwd: string;
  useColor?: boolean;
  useUnicode?: boolean;
}

export interface DoctorRunResult {
  results: CheckResult[];
  rendered: string;
  /** True iff every check returned pass / warn / skip — no fails. */
  ok: boolean;
}

function detectProjectRoot(cwd: string): string {
  // The runner is asked to start from `cwd`; we look for the nearest
  // package.json upward. If none exists, fall back to cwd unchanged
  // so individual checks can decide what to do (the playwright-installed
  // check will skip cleanly in that case).
  if (existsSync(join(cwd, 'package.json'))) return cwd;
  try {
    // findProjectRoot expects a file path; give it a fake one inside cwd
    // so it walks up from there.
    return findProjectRoot(join(cwd, 'package.json'));
  } catch {
    return cwd;
  }
}

/**
 * Programmatic entry. Runs every check in order and returns the structured
 * results PLUS the rendered terminal string. The CLI writes `rendered`
 * to stdout; tests inspect `results`.
 */
export async function runDoctor(opts: RunDoctorOptions): Promise<DoctorRunResult> {
  const ctx: DoctorContext = {
    cwd: opts.cwd,
    projectRoot: detectProjectRoot(opts.cwd),
  };

  const results: CheckResult[] = [];
  for (const check of CHECKS) {
    try {
      const r = await check(ctx);
      results.push(r);
    } catch (err) {
      // A check threw — that's a bug, but we don't want one bad check to
      // sink the whole run. Surface as a failed result with the error.
      results.push({
        name: check.name || 'unknown check',
        status: 'fail',
        message: 'Check threw an exception',
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const rendered = renderAll(results, {
    useColor: opts.useColor ?? false,
    useUnicode: opts.useUnicode ?? false,
  });
  const ok = !results.some((r) => r.status === 'fail');

  return { results, rendered, ok };
}

// Re-export for tests
export type { CheckResult, CheckStatus, DoctorContext } from './types.js';
