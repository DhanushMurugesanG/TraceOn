import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// bin/cli.js lives at the repo root, three levels up from packages/mcp/tests/.
const CLI = fileURLToPath(new URL('../../../bin/cli.js', import.meta.url));

let home: string;
let cwd: string;

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Run the CLI with an isolated HOME + cwd so a regression (a subcommand
// actually executing instead of printing help) can't touch the real
// ~/.claude.json or download the collector. stdin is closed and there's a hard
// timeout so a broken --help that falls through to the readline prompt fails
// the test instead of hanging.
function run(args: string[]): RunResult {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'traceon-cli-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'traceon-cli-cwd-'));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
});

describe('traceon CLI --help handling', () => {
  for (const sub of ['init', 'doctor']) {
    it(`\`${sub} --help\` prints usage and exits 0 without running the command`, () => {
      const r = run([sub, '--help']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Usage:');
      // Must not have executed init: no config written to HOME or cwd.
      expect(existsSync(join(home, '.claude.json'))).toBe(false);
      expect(existsSync(join(cwd, '.traceon'))).toBe(false);
    });

    it(`\`${sub} -h\` also prints usage and exits 0`, () => {
      const r = run([sub, '-h']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Usage:');
    });
  }

  it('bare `--help` still prints usage', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage:');
  });

  it('`--version` prints the version', () => {
    const r = run(['--version']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/traceon \d+\.\d+\.\d+/);
  });

  it('unknown command exits 1 with an error', () => {
    const r = run(['bogus']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Unknown command');
  });
});
