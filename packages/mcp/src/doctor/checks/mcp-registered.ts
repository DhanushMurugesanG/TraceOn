import { execFile } from 'child_process';
import { promisify } from 'util';
import type { CheckFn } from '../types.js';

const execFileP = promisify(execFile);

/**
 * Check 7 — Claude Code knows about the traceon MCP server.
 *
 * Shells out to `claude mcp list` and looks for a line matching `traceon`.
 * If `claude` isn't on PATH we warn (the user may not be using Claude Code
 * at all) rather than failing.
 */
export const mcpRegistered: CheckFn = async () => {
  let stdout = '';
  try {
    const result = await execFileP('claude', ['mcp', 'list'], { timeout: 5000 });
    stdout = result.stdout;
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string; stdout?: string };
    if (e.code === 'ENOENT') {
      return {
        name: 'MCP server is registered with Claude Code',
        status: 'warn',
        message: 'The `claude` command was not found on PATH',
        detail: 'Skipping the registration check. Install Claude Code if you intend to use TraceOn with it.',
      };
    }
    // Other failures: surface stdout/stderr if present so the user has signal
    return {
      name: 'MCP server is registered with Claude Code',
      status: 'fail',
      message: '`claude mcp list` failed',
      detail: e.message ?? 'Unknown error',
      fix: 'Re-authenticate with `claude` and ensure Claude Code is healthy, then re-run `traceon doctor`.',
    };
  }

  if (/^\s*traceon\b/m.test(stdout)) {
    return {
      name: 'MCP server is registered with Claude Code',
      status: 'pass',
      message: '`claude mcp list` includes `traceon`',
    };
  }

  return {
    name: 'MCP server is registered with Claude Code',
    status: 'fail',
    message: '`claude mcp list` does not include `traceon`',
    detail: 'The MCP server is bundled but Claude Code does not know about it.',
    fix: 'Run `traceon init` in this project, then fully quit Claude Code (Cmd+Q) and reopen it.',
  };
};
