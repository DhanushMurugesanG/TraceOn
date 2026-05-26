import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { TraceOnError, type TestSummary } from '@traceon/core';

export interface RunPlaywrightOptions {
  test: string;
  traceId: string;
  runId: string;
  evidenceDir: string;
  cwd?: string;
  /** Extra env vars forwarded to the Playwright subprocess. Overrides any
   *  matching key in `<projectRoot>/.traceon/auth.json`. */
  extraEnv?: Record<string, string>;
}

interface PWStepLocation { file?: string; line?: number; column?: number }
interface PWStepError { message?: string }
interface PWStep {
  title?: string;
  duration?: number;
  location?: PWStepLocation;
  error?: PWStepError;
  steps?: PWStep[]; // nested steps (test.step inside test.step)
}
interface PWAttachment { name?: string; path?: string; contentType?: string }
interface PWResult {
  status?: string;
  steps?: PWStep[];
  error?: { message?: string };
  attachments?: PWAttachment[];
}
interface PWReport {
  suites?: Array<{
    specs?: Array<{ title?: string; tests?: Array<{ results?: PWResult[] }> }>;
  }>;
}

/** Walk a step tree and return a flat list ordered by appearance.
 *  Playwright nests steps when `test.step` is used inside another `test.step`. */
function flattenSteps(steps: PWStep[] | undefined): PWStep[] {
  if (!steps) return [];
  const out: PWStep[] = [];
  for (const s of steps) {
    out.push(s);
    if (s.steps?.length) out.push(...flattenSteps(s.steps));
  }
  return out;
}

/** Extract the context of a timed-out test: the step that was running when
 *  the timeout fired, its source location, its own error message if any, and
 *  any attachments (screenshots, traces, videos) the report happened to
 *  contain. Returns null when the result wasn't a timeout or when there are
 *  no steps to attribute the timeout to. */
export function extractTimeoutContext(result: PWResult): {
  lastStepTitle: string;
  lastStepIndex: number;
  totalSteps: number;
  location?: string;
  lastStepError?: string;
  attachments: Array<{ name: string; path: string }>;
} | null {
  if (result.status !== 'timedOut') return null;
  const flat = flattenSteps(result.steps);
  // Heuristic: the step that was running when the timeout fired is the LAST
  // one in the flattened list — Playwright records it in order, and the
  // active-at-timeout step is the last entry (still emitted as a step even
  // though it didn't complete normally).
  const userSteps = flat.filter((s) => s.title && !s.title.startsWith('expect'));
  if (userSteps.length === 0) return null;
  const last = userSteps[userSteps.length - 1]!;
  const loc = last.location;
  const attachments = (result.attachments ?? [])
    .filter((a) => a.path && a.name)
    .map((a) => ({ name: a.name!, path: a.path! }));
  const ctx: ReturnType<typeof extractTimeoutContext> = {
    lastStepTitle: last.title!,
    lastStepIndex: userSteps.indexOf(last) + 1,
    totalSteps: userSteps.length,
    attachments,
  };
  if (loc?.file) {
    ctx.location = loc.line != null
      ? `${loc.file}:${loc.line}${loc.column != null ? `:${loc.column}` : ''}`
      : loc.file;
  }
  if (last.error?.message) ctx.lastStepError = last.error.message;
  return ctx;
}

/** Format a timeout-aware failure message. The agent reads this; lead with
 *  the actionable info (which step, where) rather than the generic timeout. */
export function formatTimeoutFailureMessage(
  ctx: NonNullable<ReturnType<typeof extractTimeoutContext>>,
  fallbackMessage: string,
): string {
  const parts: string[] = [];
  parts.push(
    `Timed out at step ${ctx.lastStepIndex}/${ctx.totalSteps}: "${ctx.lastStepTitle}"` +
    (ctx.location ? ` (${ctx.location})` : '') + '.',
  );
  if (ctx.lastStepError) parts.push(`Last action error: ${ctx.lastStepError}`);
  if (ctx.attachments.length > 0) {
    parts.push(
      'Attachments: ' + ctx.attachments.map((a) => `${a.name}=${a.path}`).join(', '),
    );
  }
  parts.push(fallbackMessage);
  return parts.join(' ');
}

function classifyStatus(exitCode: number | null, raw?: string): TestSummary['status'] {
  if (exitCode === 0) return 'passed';
  if (raw === 'timedOut') return 'timedOut';
  if (raw === 'interrupted') return 'interrupted';
  return 'failed';
}

// Walk up from the test file looking for the nearest package.json. That's
// the directory Playwright needs as its cwd so it can find the locally
// installed binary and resolve the config file.
function findProjectRoot(filePath: string): string {
  let dir = dirname(filePath);
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return dirname(filePath);
    dir = parent;
  }
}

// Resolve how to invoke Playwright. Prefer the local binary so we don't go
// through a package manager — that avoids pnpm/yarn install hooks firing
// (ERR_PNPM_IGNORED_BUILDS etc.) when all we want to do is run a test.
//
// Order: <projectRoot>/node_modules/.bin/playwright → `npx --no-install`.
// `pnpm exec` is intentionally not used; it triggers install hooks and was
// the source of every "Failed to parse Playwright report" pre-v0.0.5.
export function resolvePlaywrightInvocation(projectRoot: string): { cmd: string; baseArgs: string[] } {
  const localBin = join(projectRoot, 'node_modules', '.bin', 'playwright');
  if (existsSync(localBin)) return { cmd: localBin, baseArgs: [] };
  return { cmd: 'npx', baseArgs: ['--no-install', 'playwright'] };
}

function looksLikeMissingBinary(exitCode: number | null, stderr: string): boolean {
  if (exitCode === 127) return true;
  return /command not found|ENOENT|cannot find module|not found in path/i.test(stderr);
}

// Patterns we've seen in the wild that corrupt stdout enough to break JSON
// parsing — surfaced as specific errors with remediation rather than a
// generic "Failed to parse Playwright report".
export function detectKnownNoise(stdout: string, stderr: string): string | null {
  const all = stdout + '\n' + stderr;
  if (/ERR_PNPM_IGNORED_BUILDS/.test(all)) {
    return 'pnpm refused to run install scripts (ERR_PNPM_IGNORED_BUILDS). Run `pnpm approve-builds` in the project once, then retry verification.';
  }
  return null;
}

// Load `<projectRoot>/.traceon/auth.json` if present. Flat `{ KEY: value }`
// object — every entry becomes an env var forwarded to Playwright. The file
// is meant to be gitignored (per-machine, holds secrets like JWTs). Silent
// no-op on missing or malformed file; we don't want auth setup to be a
// verification blocker.
export function loadAuthFile(projectRoot: string): Record<string, string> {
  const authPath = join(projectRoot, '.traceon', 'auth.json');
  if (!existsSync(authPath)) return {};
  try {
    const raw = readFileSync(authPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch { /* swallow — auth file is best-effort */ }
  return {};
}

// Extract the most informative error line from Playwright's stderr for cases
// where no JSON report was written at all (webServer-timeout, config error,
// crash before tests start). Looks for the first line matching well-known
// Playwright failure patterns and returns it.
export function extractLastErrorFromStderr(stderr: string): string | undefined {
  if (!stderr) return undefined;
  // Strip ANSI color codes so the regexes work consistently
  // eslint-disable-next-line no-control-regex
  const clean = stderr.replace(/\[[0-9;]*m/g, '');
  const lines = clean.split('\n').map((l) => l.trim()).filter(Boolean);
  // Preferred patterns, in priority order. Playwright is consistent enough
  // that these cover the cases we've actually seen in the wild.
  const patterns: RegExp[] = [
    /^Error: Timed out .* from config\.webServer/i,
    /^Error: .*webServer.*/i,
    /^Error: .*config.*/i,
    /^Error: /,
    /^Timed out /i,
    /^FATAL /,
  ];
  for (const pat of patterns) {
    const hit = lines.find((l) => pat.test(l));
    if (hit) return hit;
  }
  return undefined;
}

// Pure helper for the after-spawn branch. Split out so it can be unit-tested
// without actually spawning a child process.
export function buildSummaryFromReport(args: {
  test: string;
  reportPath: string;
  exitCode: number | null;
  startTs: number;
  evidenceDir: string;
  stdout: string;
  stderr: string;
}): TestSummary {
  const { test, reportPath, exitCode, startTs, evidenceDir, stdout, stderr } = args;
  const tail = (s: string, n: number) => (s.length > n ? '…' + s.slice(-n) : s);

  let report: PWReport;
  try {
    if (!existsSync(reportPath)) {
      throw new Error(`report file not written at ${reportPath}`);
    }
    const raw = readFileSync(reportPath, 'utf-8');
    report = JSON.parse(raw) as PWReport;
  } catch (parseErr) {
    const reason = parseErr instanceof Error ? parseErr.message : String(parseErr);
    // If Playwright printed a recognisable error line to stderr (webServer
    // timeout, config error, etc.), surface THAT as the primary cause —
    // it's more useful than "Failed to read Playwright report." Fall back
    // to the generic diagnostic block when no known pattern matches.
    const surfaced = extractLastErrorFromStderr(stderr);
    return {
      file: test,
      name: 'unknown',
      status: 'interrupted',
      duration_ms: Date.now() - startTs,
      steps_executed: [],
      failure_message: surfaced
        ? `${surfaced} (exit=${exitCode}, evidence_dir=${evidenceDir})`
        : `Failed to read Playwright report (${reason}). ` +
          `exit=${exitCode}. evidence_dir=${evidenceDir}. ` +
          (stdout ? `stdout_tail=${JSON.stringify(tail(stdout, 500))}. ` : '') +
          (stderr ? `stderr_tail=${JSON.stringify(tail(stderr, 500))}` : ''),
    };
  }

  const spec = report.suites?.[0]?.specs?.[0];
  const result = spec?.tests?.[0]?.results?.[0];
  const summary: TestSummary = {
    file: test,
    name: spec?.title ?? 'unknown',
    status: classifyStatus(exitCode, result?.status),
    duration_ms: Date.now() - startTs,
    steps_executed: (result?.steps ?? []).map((s) => s.title ?? '').filter((t) => t.length > 0),
  };

  // For timed-out runs, surface per-step context (which step, where, what
  // it was trying to do) instead of the generic "Test timeout of Nms
  // exceeded". This is the difference between "useless" and "actionable"
  // for compound test failures.
  if (result && result.status === 'timedOut') {
    const ctx = extractTimeoutContext(result);
    const fallback = result.error?.message ?? 'Test timed out.';
    summary.failure_message = ctx
      ? formatTimeoutFailureMessage(ctx, fallback)
      : fallback;
  } else if (result?.error?.message) {
    summary.failure_message = result.error.message;
  }
  return summary;
}

export function runPlaywright(opts: RunPlaywrightOptions): Promise<TestSummary> {
  return new Promise((resolvePromise, rejectPromise) => {
    const startTs = Date.now();
    const absoluteTest = isAbsolute(opts.test) ? opts.test : resolve(opts.test);
    const projectRoot = opts.cwd ?? findProjectRoot(absoluteTest);
    const relativeTest = relative(projectRoot, absoluteTest);

    // Write the JSON report to a file inside evidenceDir, not stdout. stdout
    // is polluted by any package manager warning, install hook, or test
    // debug log, and `JSON.parse(stdout)` chokes on the first byte of
    // noise. Reading a file is immune to that whole class of failure.
    const reportPath = join(opts.evidenceDir, 'playwright-report.json');

    // Compose env vars forwarded to the Playwright subprocess. Priority:
    //   process.env  <  .traceon/auth.json  <  opts.extraEnv  <  TraceOn internals
    // .traceon/auth.json is the "set once" path (per-machine secrets like
    // JWTs); extraEnv is the "this run" override that always wins on collision.
    // TraceOn internals (trace id, evidence dir, report path) are non-negotiable.
    const authFromFile = loadAuthFile(projectRoot);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...authFromFile,
      ...(opts.extraEnv ?? {}),
      TRACEON_TRACE_ID: opts.traceId,
      TRACEON_RUN_ID: opts.runId,
      TRACEON_EVIDENCE_DIR: opts.evidenceDir,
      PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
    };

    const { cmd, baseArgs } = resolvePlaywrightInvocation(projectRoot);
    const child = spawn(cmd, [...baseArgs, 'test', relativeTest, '--reporter=json'], {
      cwd: projectRoot,
      env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('error', (err) => {
      rejectPromise(new TraceOnError(
        'PLAYWRIGHT_SPAWN_FAILED',
        `Failed to spawn Playwright (${cmd}): ${err.message}`,
        `Check that \`${cmd}\` is available. TraceOn first tries <project>/node_modules/.bin/playwright, then falls back to \`npx playwright\`.`,
        err,
      ));
    });

    child.on('close', (code) => {
      if (looksLikeMissingBinary(code, stderr)) {
        rejectPromise(new TraceOnError(
          'PLAYWRIGHT_SPAWN_FAILED',
          `Playwright not available in project: ${projectRoot}`,
          `Run \`npm install --save-dev @playwright/test && npx playwright install chromium\` in ${projectRoot}.`,
        ));
        return;
      }

      const noiseHint = detectKnownNoise(stdout, stderr);
      if (noiseHint) {
        rejectPromise(new TraceOnError(
          'PLAYWRIGHT_SPAWN_FAILED',
          'Playwright did not run cleanly because of package-manager noise.',
          noiseHint,
        ));
        return;
      }

      resolvePromise(buildSummaryFromReport({
        test: opts.test,
        reportPath,
        exitCode: code,
        startTs,
        evidenceDir: opts.evidenceDir,
        stdout,
        stderr,
      }));
    });
  });
}
