import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { BackendConfig } from '@traceon/core';

export interface TraceOnConfig {
  backendConfig: BackendConfig;
  evidenceRootDir: string;
}

/**
 * Backend resolution order:
 *
 * 1. `<projectRoot>/.traceon/config.json` with a `backend` field — written
 *    by `traceon init` for embedded mode (v0.2.0+).
 * 2. Legacy env-var shim: derive `backend: 'signoz'` from SIGNOZ_BASE_URL /
 *    SIGNOZ_API_KEY. Pre-v0.2.0 installs configured SigNoz exclusively via
 *    env vars in the MCP server entry and have no config file — this path
 *    keeps them working unchanged. Don't remove before v1.0.0.
 *
 * The `_env` arg (named environments from .traceonrc.yaml) remains a v1.1
 * concern; ignored as before.
 */
export function loadConfig(_env: string = 'default', projectRoot?: string): TraceOnConfig {
  const evidenceRootDir = process.env['TRACEON_EVIDENCE_ROOT'] ?? '.traceon/runs';

  const fileConfig = readProjectBackendConfig(projectRoot ?? process.cwd());
  if (fileConfig) return { backendConfig: fileConfig, evidenceRootDir };

  const apiKey = process.env['SIGNOZ_API_KEY'];
  return {
    backendConfig: {
      backend: 'signoz',
      signoz: {
        baseUrl: process.env['SIGNOZ_BASE_URL'] ?? 'http://localhost:8080',
        ...(apiKey ? { apiKey } : {}),
      },
    },
    evidenceRootDir,
  };
}

/**
 * Read and validate `.traceon/config.json`. Returns undefined when the file
 * is absent — and ALSO when it's malformed or names an unknown backend, so
 * a broken file degrades to the legacy SigNoz behavior instead of bricking
 * every verify call. The malformed case logs to stderr (visible in MCP
 * server logs) since silent fallback would be confusing to debug.
 */
export function readProjectBackendConfig(projectRoot: string): BackendConfig | undefined {
  const path = join(projectRoot, '.traceon', 'config.json');
  if (!existsSync(path)) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    console.error(
      `[traceon] ${path} is not valid JSON — falling back to env-var SigNoz config. ${err instanceof Error ? err.message : ''}`.trim(),
    );
    return undefined;
  }
  if (!raw || typeof raw !== 'object') return undefined;
  const cfg = raw as Record<string, unknown>;

  if (cfg['backend'] === 'embedded') {
    const embedded = (cfg['embedded'] ?? {}) as Record<string, unknown>;
    return {
      backend: 'embedded',
      embedded: {
        ...(typeof embedded['port'] === 'number' ? { port: embedded['port'] } : {}),
        ...(typeof embedded['dataDir'] === 'string' ? { dataDir: embedded['dataDir'] } : {}),
        ...(embedded['settle'] && typeof embedded['settle'] === 'object'
          ? { settle: embedded['settle'] as Record<string, number> }
          : {}),
      },
    };
  }

  if (cfg['backend'] === 'signoz') {
    const signoz = (cfg['signoz'] ?? {}) as Record<string, unknown>;
    const baseUrl =
      typeof signoz['baseUrl'] === 'string'
        ? signoz['baseUrl']
        : process.env['SIGNOZ_BASE_URL'] ?? 'http://localhost:8080';
    // API keys belong in env vars, not project files (config.json is likely
    // to be committed). Accept one if present, but prefer the env var.
    const apiKey = process.env['SIGNOZ_API_KEY'] ??
      (typeof signoz['apiKey'] === 'string' ? signoz['apiKey'] : undefined);
    return {
      backend: 'signoz',
      signoz: { baseUrl, ...(apiKey ? { apiKey } : {}) },
    };
  }

  if (cfg['backend'] !== undefined) {
    console.error(
      `[traceon] Unknown backend "${String(cfg['backend'])}" in ${path} — falling back to env-var SigNoz config.`,
    );
  }
  return undefined;
}
