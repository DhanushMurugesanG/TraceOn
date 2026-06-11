import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { collectorBinaryPath, OTELCOL_VERSION } from '@traceon/core';
import { readProjectBackendConfig } from '../../config.js';
import type { CheckFn } from '../types.js';
import { fetchWithTimeout } from './_http.js';

/**
 * Check 6 — the configured trace backend is available.
 *
 * Embedded backend (project .traceon/config.json says so): verify the
 * collector binary is installed — the collector itself is spawned lazily
 * by the MCP server, so there's no live process to probe at doctor time.
 *
 * SigNoz backend: reads the user's MCP server config (from Claude Code's
 * ~/.claude.json or Claude Desktop's config) and pulls the
 * SIGNOZ_BASE_URL env var from the traceon entry, falling back to the
 * common default. HEADs it.
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
  const backendConfig = readProjectBackendConfig(ctx.projectRoot);
  if (backendConfig?.backend === 'embedded') {
    const binPath = collectorBinaryPath();
    if (existsSync(binPath)) {
      return {
        name: 'Embedded collector installed',
        status: 'pass',
        message: `otelcol-contrib v${OTELCOL_VERSION} at ${binPath}`,
      };
    }
    return {
      name: 'Embedded collector installed',
      status: 'fail',
      message: `Collector binary not found at ${binPath}`,
      fix: 'Re-run `traceon init` and choose the embedded backend to download it.',
    };
  }

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
