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
// Minimum poll interval (ms). Floors `pollMs` so a config of 0 can't turn the
// settle loop into a CPU-pinning busy-spin that re-reads the trace file as fast
// as the event loop allows.
const MIN_POLL_MS = 50;
const SETTLE_KEYS = ['maxWaitMs', 'stabilityMs', 'pollMs'] as const;

/**
 * Validate the embedded `settle` block from config.json. Only positive, finite
 * numbers survive; anything else (0, NaN, strings, negatives) is dropped with a
 * stderr note so the defaults apply instead of corrupting the timing math
 * (`pollMs: 0` → busy-loop; `stabilityMs: "x"` → NaN → never settles).
 */
function sanitizeSettle(raw: unknown, path: string): { settle?: Record<string, number> } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const src = raw as Record<string, unknown>;
  const settle: Record<string, number> = {};
  for (const key of SETTLE_KEYS) {
    const v = src[key];
    if (v === undefined) continue;
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
      settle[key] = key === 'pollMs' ? Math.max(MIN_POLL_MS, v) : v;
    } else {
      console.error(
        `[traceon] Ignoring invalid embedded.settle.${key} (${JSON.stringify(v)}) in ${path} — must be a positive number. Using the default.`,
      );
    }
  }
  return Object.keys(settle).length > 0 ? { settle } : {};
}

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
        ...sanitizeSettle(embedded['settle'], path),
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
