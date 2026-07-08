import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import type { CheckFn, CheckResult } from '../types.js';

/**
 * Check 2 — Chromium actually launches.
 *
 * `playwrightInstalled` only checks that the npm package is on disk. That's a
 * false-green on WSL2 / minimal Linux, where the package installs fine but
 * Chromium can't launch because system libraries (libnss3, libatk-bridge, …)
 * are missing. This check actually launches a headless browser so that
 * failure mode is caught instead of surfacing later as a mysterious verify
 * error. Reported by Thirumalaiboobathi (Madurai AI Community) on WSL2 Ubuntu.
 *
 * `npx playwright install --dry-run` is NOT enough here — it reports whether
 * browser binaries are downloaded, not whether they can launch against the
 * system's shared libraries. Only a real launch exercises libnss3 et al.
 */

const LAUNCH_TIMEOUT_MS = 20_000; // first launch on a cold machine is slow

export type LaunchFailure = 'missing-deps' | 'browser-not-installed' | 'other';

/**
 * Classify a failed Chromium launch from its stderr. Pure + exported so it can
 * be unit-tested against captured error strings without spawning a browser.
 * Order matters: the missing-deps message also contains "playwright install"
 * (as "install-deps"), so it must be matched before browser-not-installed.
 */
export function classifyLaunchFailure(stderr: string): LaunchFailure {
  const s = stderr.toLowerCase();
  if (
    /host system is missing dependencies|error while loading shared libraries|libnss3|libatk|libgbm|libasound|libxkbcommon/.test(
      s,
    )
  ) {
    return 'missing-deps';
  }
  if (/executable doesn'?t exist|playwright install(?!-deps)|download new browsers/.test(s)) {
    return 'browser-not-installed';
  }
  return 'other';
}

// Strip ANSI so `detail` reads cleanly, and cap length.
function cleanStderr(stderr: string): string {
  // eslint-disable-next-line no-control-regex
  const noAnsi = stderr.replace(/\[[0-9;]*m/g, '').trim();
  return noAnsi.length > 600 ? noAnsi.slice(0, 600) + '…' : noAnsi;
}

interface LaunchResult {
  ok: boolean;
  timedOut: boolean;
  stderr: string;
}

// Launch headless Chromium via the PROJECT's @playwright/test (resolved from
// projectRoot's node_modules), with a hard timeout. Split out so the CheckFn
// stays readable; the real spawn is exercised by local/integration runs, while
// classifyLaunchFailure carries the unit-tested decision logic.
function probeLaunch(projectRoot: string): Promise<LaunchResult> {
  const script =
    '(async () => { try { const { chromium } = require("@playwright/test");' +
    ' const b = await chromium.launch({ headless: true }); await b.close();' +
    ' process.exit(0); } catch (e) { console.error(e && e.message ? e.message : String(e)); process.exit(1); } })();';

  return new Promise((resolve) => {
    const child = spawn('node', ['-e', script], {
      cwd: projectRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ ok: false, timedOut: true, stderr });
    }, LAUNCH_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, timedOut: false, stderr: stderr || String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, timedOut: false, stderr });
    });
  });
}

export const chromiumLaunches: CheckFn = async (ctx): Promise<CheckResult> => {
  // If Playwright isn't installed at all, playwrightInstalled already failed —
  // don't pile on. Skip cleanly.
  const binPath = join(ctx.projectRoot, 'node_modules', '.bin', 'playwright');
  if (!existsSync(binPath)) {
    return {
      name: 'Chromium launches',
      status: 'skip',
      message: 'Skipped — Playwright not installed (see the check above)',
    };
  }

  const result = await probeLaunch(ctx.projectRoot);

  if (result.ok) {
    return {
      name: 'Chromium launches',
      status: 'pass',
      message: 'Headless Chromium launched and closed cleanly',
    };
  }

  if (result.timedOut) {
    return {
      name: 'Chromium launches',
      status: 'warn',
      message: `Chromium launch did not finish within ${LAUNCH_TIMEOUT_MS / 1000}s`,
      detail:
        'The launch probe timed out — could be a slow first-run download or a stuck browser process. Try `npx playwright test` directly to see the real error.',
    };
  }

  const kind = classifyLaunchFailure(result.stderr);
  const detail = cleanStderr(result.stderr);

  if (kind === 'missing-deps') {
    return {
      name: 'Chromium launches',
      status: 'fail',
      message: 'Chromium is installed but cannot launch — missing system libraries',
      detail,
      fix:
        'Install the browser system dependencies (common on WSL2 / minimal Linux):\n' +
        '  sudo npx playwright install-deps\n' +
        'Or manually:\n' +
        '  sudo apt install -y libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 libgbm1 libasound2 libxkbcommon0\n' +
        'See docs/wsl-setup.md for the full WSL walkthrough.',
    };
  }

  if (kind === 'browser-not-installed') {
    return {
      name: 'Chromium launches',
      status: 'fail',
      message: 'Chromium browser binary is not downloaded',
      detail,
      fix: 'npx playwright install chromium',
    };
  }

  return {
    name: 'Chromium launches',
    status: 'warn',
    message: 'Could not confirm Chromium launches',
    detail: detail || 'Launch failed with no error output.',
    fix: 'Run `npx playwright test` in this project to see the underlying error.',
  };
};
