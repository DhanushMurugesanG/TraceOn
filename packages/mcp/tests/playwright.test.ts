/**
 * Unit tests for the Playwright invocation helpers.
 *
 * These tests don't actually spawn Playwright — they cover the two bug
 * classes that surfaced in v0.0.4 and earlier:
 *
 *   1. Hardcoded `pnpm exec` invocation broke for non-pnpm users and
 *      triggered pnpm install hooks (ERR_PNPM_IGNORED_BUILDS).
 *   2. `JSON.parse(stdout)` corrupted by ANY non-JSON byte ahead of the
 *      report, so a passing test could still be reported as "interrupted".
 *
 * Anchor cases are below; if either bug regresses, these tests fail.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  resolvePlaywrightInvocation,
  detectKnownNoise,
  buildSummaryFromReport,
  loadAuthFile,
  extractLastErrorFromStderr,
  extractTimeoutContext,
  formatTimeoutFailureMessage,
} from '../src/playwright.js';

const tmpDirs: string[] = [];
function mkTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'traceon-pw-test-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop()!;
    try { rmSync(d, { recursive: true, force: true }); } catch { /* swallow */ }
  }
});

describe('resolvePlaywrightInvocation', () => {
  it('prefers <projectRoot>/node_modules/.bin/playwright when it exists', () => {
    const root = mkTmp();
    const binDir = join(root, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const binPath = join(binDir, 'playwright');
    writeFileSync(binPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const { cmd, baseArgs } = resolvePlaywrightInvocation(root);
    expect(cmd).toBe(binPath);
    expect(baseArgs).toEqual([]);
  });

  it('falls back to `npx --no-install playwright` when there is no local binary', () => {
    const root = mkTmp(); // empty — no node_modules

    const { cmd, baseArgs } = resolvePlaywrightInvocation(root);
    expect(cmd).toBe('npx');
    expect(baseArgs).toEqual(['--no-install', 'playwright']);
  });

  it('never returns `pnpm exec` (regression: v0.0.4 always used pnpm and triggered install hooks)', () => {
    const root = mkTmp();
    const { cmd } = resolvePlaywrightInvocation(root);
    expect(cmd).not.toBe('pnpm');
  });
});

describe('detectKnownNoise', () => {
  it('catches ERR_PNPM_IGNORED_BUILDS on stderr and recommends `pnpm approve-builds`', () => {
    const hint = detectKnownNoise(
      '',
      ' ERR_PNPM_IGNORED_BUILDS  Ignored build scripts: esbuild.\n',
    );
    expect(hint).not.toBeNull();
    expect(hint!).toMatch(/pnpm approve-builds/);
  });

  it('catches ERR_PNPM_IGNORED_BUILDS on stdout (pnpm sometimes writes warnings there)', () => {
    const hint = detectKnownNoise('[WARN] ERR_PNPM_IGNORED_BUILDS\n', '');
    expect(hint).not.toBeNull();
  });

  it('returns null on clean output', () => {
    expect(detectKnownNoise('', '')).toBeNull();
    expect(detectKnownNoise('Running 1 test using 1 worker\n', '')).toBeNull();
  });
});

describe('buildSummaryFromReport', () => {
  function baseArgs(overrides: Partial<Parameters<typeof buildSummaryFromReport>[0]> = {}) {
    const evidenceDir = mkTmp();
    return {
      test: '/abs/test.spec.ts',
      reportPath: join(evidenceDir, 'playwright-report.json'),
      exitCode: 0,
      startTs: Date.now() - 100,
      evidenceDir,
      stdout: '',
      stderr: '',
      ...overrides,
    };
  }

  it('parses a passing report from the file (regression: stdout noise no longer matters)', () => {
    const args = baseArgs();
    writeFileSync(args.reportPath, JSON.stringify({
      suites: [{
        specs: [{
          title: 'save as draft creates a draft',
          tests: [{ results: [{ status: 'passed', steps: [{ title: 'Open wizard' }] }] }],
        }],
      }],
    }));

    // Even with corrupted stdout, the file-based read succeeds.
    const summary = buildSummaryFromReport({ ...args, stdout: '[WARN] pnpm garbage\n' });
    expect(summary.status).toBe('passed');
    expect(summary.name).toBe('save as draft creates a draft');
    expect(summary.steps_executed).toEqual(['Open wizard']);
    expect(summary.failure_message).toBeUndefined();
  });

  it('classifies a non-zero exit with a failed result as `failed`', () => {
    const args = baseArgs({ exitCode: 1 });
    writeFileSync(args.reportPath, JSON.stringify({
      suites: [{
        specs: [{
          title: 'broken test',
          tests: [{ results: [{
            status: 'failed',
            steps: [],
            error: { message: 'expect(received).toBe(expected)' },
          }] }],
        }],
      }],
    }));

    const summary = buildSummaryFromReport(args);
    expect(summary.status).toBe('failed');
    expect(summary.failure_message).toBe('expect(received).toBe(expected)');
  });

  it('returns interrupted with diagnostic detail when the report file is missing', () => {
    const args = baseArgs({
      exitCode: 2,
      stdout: 'some pre-crash chatter\n',
      stderr: 'fatal: cannot find module\n',
    });
    // intentionally do NOT write reportPath

    const summary = buildSummaryFromReport(args);
    expect(summary.status).toBe('interrupted');
    expect(summary.name).toBe('unknown');
    expect(summary.failure_message).toBeDefined();
    expect(summary.failure_message!).toMatch(/report file not written/);
    expect(summary.failure_message!).toMatch(/exit=2/);
    expect(summary.failure_message!).toMatch(/evidence_dir=/);
    expect(summary.failure_message!).toMatch(/stdout_tail=.*pre-crash/);
    expect(summary.failure_message!).toMatch(/stderr_tail=.*cannot find module/);
  });

  it('returns interrupted with the parse error when the report file is corrupt', () => {
    const args = baseArgs({ exitCode: 0 });
    writeFileSync(args.reportPath, '{ not valid json');

    const summary = buildSummaryFromReport(args);
    expect(summary.status).toBe('interrupted');
    // The exact JSON.parse error text varies by Node version — just check it's surfaced.
    expect(summary.failure_message!).toMatch(/Failed to read Playwright report/);
    expect(summary.failure_message!).not.toMatch(/report file not written/);
  });

  // Regression for v0.0.6 feedback: webServer-timeout returned name:"unknown",
  // steps_executed:[], failure_message:"" because the report file was never
  // written and the generic fallback didn't surface the real error from
  // stderr. After v0.0.7, the actual Playwright error line is bubbled up.
  it('surfaces the webServer-timeout error from stderr when no report exists', () => {
    const args = baseArgs({
      exitCode: 1,
      stderr:
        '\n' +
        'Error: Timed out waiting 120000ms from config.webServer.\n' +
        '    at /path/to/playwright/lib/server.js:42:11\n',
    });
    // intentionally do NOT write reportPath

    const summary = buildSummaryFromReport(args);
    expect(summary.status).toBe('interrupted');
    expect(summary.failure_message).toBeDefined();
    expect(summary.failure_message!).toMatch(/Timed out waiting 120000ms from config\.webServer/);
    expect(summary.failure_message!).toMatch(/exit=1/);
    expect(summary.failure_message!).toMatch(/evidence_dir=/);
    // Should NOT use the generic fallback when a specific error line was found
    expect(summary.failure_message!).not.toMatch(/Failed to read Playwright report/);
  });
});

describe('extractLastErrorFromStderr', () => {
  it('extracts a webServer-timeout error line', () => {
    const stderr = '\nError: Timed out waiting 120000ms from config.webServer.\n  at server.js:42\n';
    expect(extractLastErrorFromStderr(stderr))
      .toBe('Error: Timed out waiting 120000ms from config.webServer.');
  });

  it('extracts a generic Error: line when no specific pattern matches', () => {
    const stderr = '\nError: cannot resolve config\n';
    expect(extractLastErrorFromStderr(stderr)).toBe('Error: cannot resolve config');
  });

  it('strips ANSI color codes before matching', () => {
    const stderr = '[31mError: Timed out waiting 5000ms from config.webServer[0m\n';
    const result = extractLastErrorFromStderr(stderr);
    expect(result).toBeDefined();
    expect(result!).toMatch(/Timed out waiting 5000ms/);
    expect(result!).not.toMatch(//);
  });

  it('returns undefined on clean stderr with no recognised error pattern', () => {
    expect(extractLastErrorFromStderr('')).toBeUndefined();
    expect(extractLastErrorFromStderr('some innocuous warning\n')).toBeUndefined();
  });
});

describe('loadAuthFile', () => {
  it('returns empty object when .traceon/auth.json is missing', () => {
    const root = mkTmp();
    expect(loadAuthFile(root)).toEqual({});
  });

  it('loads flat string-value pairs from .traceon/auth.json', () => {
    const root = mkTmp();
    mkdirSync(join(root, '.traceon'), { recursive: true });
    writeFileSync(
      join(root, '.traceon', 'auth.json'),
      JSON.stringify({ AUTH_TOKEN: 'ey.jwt.value', API_BASE_URL: 'http://localhost:8080' }),
    );

    expect(loadAuthFile(root)).toEqual({
      AUTH_TOKEN: 'ey.jwt.value',
      API_BASE_URL: 'http://localhost:8080',
    });
  });

  it('drops non-string values silently (best-effort, no throwing)', () => {
    const root = mkTmp();
    mkdirSync(join(root, '.traceon'), { recursive: true });
    writeFileSync(
      join(root, '.traceon', 'auth.json'),
      JSON.stringify({ AUTH_TOKEN: 'good', RETRIES: 3, NESTED: { x: 1 } }),
    );

    expect(loadAuthFile(root)).toEqual({ AUTH_TOKEN: 'good' });
  });

  it('returns empty object on malformed JSON instead of throwing', () => {
    const root = mkTmp();
    mkdirSync(join(root, '.traceon'), { recursive: true });
    writeFileSync(join(root, '.traceon', 'auth.json'), '{ not json');

    expect(loadAuthFile(root)).toEqual({});
  });

  it('returns empty object when auth.json is an array (must be a flat object)', () => {
    const root = mkTmp();
    mkdirSync(join(root, '.traceon'), { recursive: true });
    writeFileSync(
      join(root, '.traceon', 'auth.json'),
      JSON.stringify([{ AUTH_TOKEN: 'wrong shape' }]),
    );

    expect(loadAuthFile(root)).toEqual({});
  });
});

// Regression for v0.0.7 feedback round-2: long compound tests that timed out
// returned a generic "Test timeout of 180000ms exceeded" with no signal about
// which step or where. v0.0.8 surfaces per-step context.
describe('extractTimeoutContext', () => {
  it('returns null for non-timeout results', () => {
    expect(extractTimeoutContext({ status: 'passed', steps: [{ title: 'a' }] })).toBeNull();
    expect(extractTimeoutContext({ status: 'failed', steps: [{ title: 'a' }] })).toBeNull();
  });

  it('returns null when there are no user-facing steps', () => {
    expect(extractTimeoutContext({ status: 'timedOut', steps: [] })).toBeNull();
    expect(extractTimeoutContext({
      status: 'timedOut',
      steps: [{ title: 'expect.toBeVisible' }],
    })).toBeNull();
  });

  it('extracts the last user step with location, index, and error', () => {
    const ctx = extractTimeoutContext({
      status: 'timedOut',
      steps: [
        { title: 'Open the wizard', duration: 200 },
        { title: 'Fill in fields', duration: 400 },
        {
          title: 'Click Save Draft',
          duration: 166000,
          location: { file: 'tests/save.spec.ts', line: 42, column: 7 },
          error: { message: 'locator.fill: Target page, context or browser has been closed' },
        },
      ],
    });
    expect(ctx).not.toBeNull();
    expect(ctx!.lastStepTitle).toBe('Click Save Draft');
    expect(ctx!.lastStepIndex).toBe(3);
    expect(ctx!.totalSteps).toBe(3);
    expect(ctx!.location).toBe('tests/save.spec.ts:42:7');
    expect(ctx!.lastStepError).toContain('Target page, context or browser has been closed');
  });

  it('flattens nested steps so test.step inside test.step is reachable', () => {
    const ctx = extractTimeoutContext({
      status: 'timedOut',
      steps: [
        { title: 'Outer step', steps: [{ title: 'Inner step', location: { file: 'a.ts', line: 5 } }] },
      ],
    });
    expect(ctx!.lastStepTitle).toBe('Inner step');
    expect(ctx!.location).toBe('a.ts:5');
  });

  it('captures attachments with paths (screenshots, traces, videos)', () => {
    const ctx = extractTimeoutContext({
      status: 'timedOut',
      steps: [{ title: 'do thing' }],
      attachments: [
        { name: 'screenshot', path: '/tmp/test-failed-1.png', contentType: 'image/png' },
        { name: 'trace', path: '/tmp/trace.zip', contentType: 'application/zip' },
        { name: 'no-path-attachment' }, // dropped silently — no path
      ],
    });
    expect(ctx!.attachments).toEqual([
      { name: 'screenshot', path: '/tmp/test-failed-1.png' },
      { name: 'trace', path: '/tmp/trace.zip' },
    ]);
  });

  it('drops the optional location when no file is recorded', () => {
    const ctx = extractTimeoutContext({
      status: 'timedOut',
      steps: [{ title: 'no location info' }],
    });
    expect(ctx!.location).toBeUndefined();
  });
});

describe('formatTimeoutFailureMessage', () => {
  it('leads with the failing step and includes the per-step error', () => {
    const msg = formatTimeoutFailureMessage(
      {
        lastStepTitle: 'Click Save Draft',
        lastStepIndex: 13,
        totalSteps: 14,
        location: 'tests/save.spec.ts:42:7',
        lastStepError: 'locator.fill: Target page, context or browser has been closed',
        attachments: [{ name: 'screenshot', path: '/tmp/x.png' }],
      },
      'Test timeout of 180000ms exceeded',
    );
    expect(msg).toMatch(/Timed out at step 13\/14: "Click Save Draft" \(tests\/save\.spec\.ts:42:7\)/);
    expect(msg).toMatch(/Last action error: locator\.fill/);
    expect(msg).toMatch(/Attachments: screenshot=\/tmp\/x\.png/);
    expect(msg).toMatch(/Test timeout of 180000ms exceeded$/);
  });

  it('omits sections cleanly when there is no error or attachments', () => {
    const msg = formatTimeoutFailureMessage(
      {
        lastStepTitle: 'idle wait',
        lastStepIndex: 1,
        totalSteps: 1,
        attachments: [],
      },
      'Test timed out.',
    );
    expect(msg).toMatch(/Timed out at step 1\/1: "idle wait"\./);
    expect(msg).not.toMatch(/Last action error:/);
    expect(msg).not.toMatch(/Attachments:/);
    expect(msg).toMatch(/Test timed out\.$/);
  });
});

describe('buildSummaryFromReport timeout path', () => {
  function baseArgs(overrides: Partial<Parameters<typeof buildSummaryFromReport>[0]> = {}) {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'traceon-pw-test-tmt-'));
    tmpDirs.push(evidenceDir);
    return {
      test: '/abs/test.spec.ts',
      reportPath: join(evidenceDir, 'playwright-report.json'),
      exitCode: 1,
      startTs: Date.now() - 180_000,
      evidenceDir,
      stdout: '',
      stderr: '',
      ...overrides,
    };
  }

  it('produces an actionable failure_message on timeout, not the generic line', () => {
    const args = baseArgs();
    writeFileSync(args.reportPath, JSON.stringify({
      suites: [{
        specs: [{
          title: 'autosave at 30s idle',
          tests: [{
            results: [{
              status: 'timedOut',
              steps: [
                { title: 'Open editor' },
                { title: 'Type 100 chars' },
                {
                  title: 'Wait 30s',
                  location: { file: 'autosave.spec.ts', line: 81 },
                  error: { message: 'Action timed out waiting for the idle event' },
                },
              ],
              error: { message: 'Test timeout of 180000ms exceeded' },
            }],
          }],
        }],
      }],
    }));

    const summary = buildSummaryFromReport(args);
    expect(summary.status).toBe('timedOut');
    expect(summary.failure_message).toBeDefined();
    expect(summary.failure_message!).toMatch(/Timed out at step 3\/3: "Wait 30s" \(autosave\.spec\.ts:81\)/);
    expect(summary.failure_message!).toMatch(/Last action error: Action timed out waiting for the idle event/);
    expect(summary.failure_message!).toMatch(/Test timeout of 180000ms exceeded$/);
  });
});
