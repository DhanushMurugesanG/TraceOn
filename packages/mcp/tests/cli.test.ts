import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
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
  for (const sub of ['init', 'doctor', 'mcp']) {
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

// `traceon mcp` imports the bundled dist/mcp.js, which only exists after
// `pnpm build:all` — skip rather than fail on a fresh checkout.
const MCP_BUNDLE = fileURLToPath(new URL('../../../dist/mcp.js', import.meta.url));

describe.skipIf(!existsSync(MCP_BUNDLE))('traceon mcp', () => {
  it('speaks MCP over stdio, lists traceon_verify, and exits 0 when stdin closes', async () => {
    const child = spawn('node', [CLI, 'mcp'], {
      cwd,
      env: { ...process.env, HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => (stdout += chunk));

    const send = (msg: object) => child.stdin.write(JSON.stringify(msg) + '\n');
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'cli-test', version: '0' },
      },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    // Wait for the tools/list response, then close stdin like a client would.
    const deadline = Date.now() + 10_000;
    while (!stdout.includes('"id":2') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const exit = new Promise<number | null>((r) => child.on('exit', r));
    child.stdin.end();
    const code = await exit;

    // Every stdout line must be a JSON-RPC message — anything else corrupts
    // the transport for the client.
    const messages = stdout.trim().split('\n').map((line) => JSON.parse(line));
    const toolsList = messages.find((m) => m.id === 2);
    expect(toolsList.result.tools.map((t: { name: string }) => t.name)).toEqual([
      'traceon_verify',
    ]);
    expect(code).toBe(0);
  }, 20_000);
});
