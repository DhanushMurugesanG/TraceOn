import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import type { CheckFn } from '../types.js';

const execFileP = promisify(execFile);

/**
 * Check 7 — Claude Code knows about the traceon MCP server.
 *
 * Registration lives in the Claude config file (~/.claude.json for Claude
 * Code, ~/Library/Application Support/Claude/claude_desktop_config.json
 * for Claude Desktop on macOS). That's the source of truth — we read it
 * DIRECTLY. Whether Claude Code's daemon can currently connect to the
 * spawned MCP server is a separate question, and one that `claude mcp
 * list` sometimes can't answer even when everything's fine (round-1 alpha
 * feedback: user's subprocess environment made `claude mcp list` crash
 * while the actual registration was working perfectly).
 *
 * So: check the config file(s) first. If traceon is registered somewhere,
 * pass — and optionally add a connection note from `claude mcp list` when
 * it's available. If claude CLI fails, that's not our problem; do not fail
 * this check on it.
 */

function claudeConfigPaths(): string[] {
  const paths: string[] = [join(homedir(), '.claude.json')];
  if (platform() === 'darwin') {
    paths.push(
      join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    );
  } else if (platform() === 'linux') {
    paths.push(join(homedir(), '.config', 'Claude', 'claude_desktop_config.json'));
  }
  return paths;
}

interface ClaudeConfig {
  mcpServers?: Record<string, unknown>;
}

/** Returns the list of config paths where mcpServers.traceon is present. */
export function findTraceonRegistrations(configPaths: string[]): string[] {
  const found: string[] = [];
  for (const p of configPaths) {
    if (!existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf-8')) as ClaudeConfig;
      if (cfg?.mcpServers && Object.prototype.hasOwnProperty.call(cfg.mcpServers, 'traceon')) {
        found.push(p);
      }
    } catch { /* swallow — best-effort */ }
  }
  return found;
}

async function tryClaudeMcpList(): Promise<{ stdout: string } | null> {
  try {
    return await execFileP('claude', ['mcp', 'list'], { timeout: 5000 });
  } catch {
    return null;
  }
}

export const mcpRegistered: CheckFn = async () => {
  const configPaths = claudeConfigPaths();
  const foundIn = findTraceonRegistrations(configPaths);

  if (foundIn.length > 0) {
    // Registration confirmed via config file. Try `claude mcp list` for a
    // connection-health note, but do NOT let that call's failure demote
    // the check — the registration IS there.
    let connectionNote = '';
    const listed = await tryClaudeMcpList();
    if (listed && /^\s*traceon\b/m.test(listed.stdout)) {
      if (/traceon.*(?:Connected|✔|✓)/i.test(listed.stdout)) {
        connectionNote = ' and `claude mcp list` reports it Connected';
      } else {
        connectionNote = ' and Claude Code sees it';
      }
    }
    return {
      name: 'MCP server is registered with Claude Code',
      status: 'pass',
      message: `Registered in ${foundIn.length} config file(s)${connectionNote}`,
      detail: foundIn.map((p) => `  ${p}`).join('\n'),
    };
  }

  // Not in any local config file. Fall through to `claude mcp list` for a
  // second opinion — the user might have a config in a location we don't
  // know about, or claude may have registered it via a mechanism outside
  // our detection.
  const listed = await tryClaudeMcpList();

  if (listed && /^\s*traceon\b/m.test(listed.stdout)) {
    return {
      name: 'MCP server is registered with Claude Code',
      status: 'pass',
      message: '`claude mcp list` includes `traceon`',
      detail: 'Not found in the config files we checked, but Claude Code knows about it.',
    };
  }

  if (!listed) {
    // Neither config file nor claude CLI could confirm registration.
    // Warn (not fail) — the user may not be running Claude Code at all,
    // and failing here would be a false negative for Claude Desktop-only
    // or IDE-integration users.
    return {
      name: 'MCP server is registered with Claude Code',
      status: 'warn',
      message: 'Could not verify registration',
      detail:
        `Not found in ${configPaths.join(' or ')}, and \`claude mcp list\` did not return output. ` +
        'This is only a real problem if you intend to use TraceOn with Claude Code — the check is inconclusive here.',
      fix: 'Run `traceon init` in this project to register with Claude Code.',
    };
  }

  return {
    name: 'MCP server is registered with Claude Code',
    status: 'fail',
    message: '`traceon` is not registered',
    detail:
      `Not present in ${configPaths.join(' or ')} and \`claude mcp list\` doesn't list it.`,
    fix: 'Run `traceon init` in this project, then fully quit Claude Code (Cmd+Q) and reopen it.',
  };
};
