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
});
