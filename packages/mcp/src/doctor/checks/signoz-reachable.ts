import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { CheckFn } from '../types.js';
import { fetchWithTimeout } from './_http.js';

/**
 * Check 6 — SigNoz (or whichever observability backend is configured)
 * is reachable.
 *
 * Reads the user's MCP server config (from Claude Code's ~/.claude.json
 * or the project's .traceon directory if it ever moves there) and pulls
 * the SIGNOZ_BASE_URL env var from the traceon entry. Falls back to the
 * common default if not found.
 */

const SIGNOZ_DEFAULT = 'http://localhost:8080';

function readSignozUrlFromClaudeConfig(): string | undefined {
  const paths = [
    join(homedir(), '.claude.json'),
    join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  ];
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const cfg = JSON.parse(readFileSync(p, 'utf-8'));
      const env = cfg?.mcpServers?.traceon?.env;
      if (env?.SIGNOZ_BASE_URL) return env.SIGNOZ_BASE_URL;
    } catch { /* swallow — best-effort */ }
  }
  return undefined;
}

export const signozReachable: CheckFn = async (ctx) => {
  const url = readSignozUrlFromClaudeConfig() ?? SIGNOZ_DEFAULT;
  ctx.signozBaseUrl = url;

  const res = await fetchWithTimeout(url, { method: 'HEAD', timeoutMs: 3000 });
  if (res.ok && res.status >= 200 && res.status < 500) {
    // 4xx is fine — the server is alive, just doesn't like HEAD on root
    return {
      name: `SigNoz reachable at ${url}`,
      status: 'pass',
      message: `Got HTTP ${res.status}`,
    };
  }

  return {
    name: 'SigNoz reachable',
    status: 'fail',
    message: `Could not reach ${url}`,
    detail: res.ok ? `HTTP ${res.status}` : res.error,
    fix: 'Ensure SigNoz is running (e.g. `docker compose up` in your SigNoz install dir) and confirm the URL in your traceon MCP server config.',
  };
};
