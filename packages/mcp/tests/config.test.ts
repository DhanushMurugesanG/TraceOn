import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, readProjectBackendConfig } from '../src/config.js';
import { signozReachable } from '../src/doctor/checks/signoz-reachable.js';
import type { DoctorContext } from '../src/doctor/types.js';

let projectRoot: string;

function writeProjectConfig(obj: unknown): void {
  mkdirSync(join(projectRoot, '.traceon'), { recursive: true });
  const content = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  writeFileSync(join(projectRoot, '.traceon', 'config.json'), content);
}

const ENV_KEYS = ['SIGNOZ_BASE_URL', 'SIGNOZ_API_KEY', 'TRACEON_EVIDENCE_ROOT'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'traceon-config-'));
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('loadConfig backward compat (no config file)', () => {
  it('defaults to SigNoz at localhost:8080 — exact pre-v0.2.0 behavior', () => {
    const cfg = loadConfig('default', projectRoot);
    expect(cfg.backendConfig).toEqual({
      backend: 'signoz',
      signoz: { baseUrl: 'http://localhost:8080' },
    });
    expect(cfg.evidenceRootDir).toBe('.traceon/runs');
  });

  it('derives SigNoz config from legacy env vars (the v0.0.x shim)', () => {
    process.env['SIGNOZ_BASE_URL'] = 'http://signoz.internal:9999';
    process.env['SIGNOZ_API_KEY'] = 'sekrit';
    const cfg = loadConfig('default', projectRoot);
    expect(cfg.backendConfig).toEqual({
      backend: 'signoz',
      signoz: { baseUrl: 'http://signoz.internal:9999', apiKey: 'sekrit' },
    });
  });

  it('honors TRACEON_EVIDENCE_ROOT', () => {
    process.env['TRACEON_EVIDENCE_ROOT'] = '/tmp/evidence';
    expect(loadConfig('default', projectRoot).evidenceRootDir).toBe('/tmp/evidence');
  });
});

describe('loadConfig with .traceon/config.json', () => {
  it('loads an embedded backend with options', () => {
    writeProjectConfig({
      backend: 'embedded',
      embedded: { port: 5555, dataDir: '/custom/dir', settle: { maxWaitMs: 30000 } },
    });
    const cfg = loadConfig('default', projectRoot);
    expect(cfg.backendConfig).toEqual({
      backend: 'embedded',
      embedded: { port: 5555, dataDir: '/custom/dir', settle: { maxWaitMs: 30000 } },
    });
  });

  it('loads a minimal embedded config (defaults applied downstream)', () => {
    writeProjectConfig({ backend: 'embedded' });
    expect(loadConfig('default', projectRoot).backendConfig).toEqual({
      backend: 'embedded',
      embedded: {},
    });
  });

  it('loads a signoz config file, preferring the env API key over the file', () => {
    process.env['SIGNOZ_API_KEY'] = 'from-env';
    writeProjectConfig({
      backend: 'signoz',
      signoz: { baseUrl: 'http://from-file:8080', apiKey: 'from-file' },
    });
    expect(loadConfig('default', projectRoot).backendConfig).toEqual({
      backend: 'signoz',
      signoz: { baseUrl: 'http://from-file:8080', apiKey: 'from-env' },
    });
  });

  it('falls back to the env shim when the file is malformed JSON', () => {
    writeProjectConfig('{ backend: embedded'); // not JSON
    process.env['SIGNOZ_BASE_URL'] = 'http://fallback:8080';
    const cfg = loadConfig('default', projectRoot);
    expect(cfg.backendConfig.backend).toBe('signoz');
    expect((cfg.backendConfig as { signoz: { baseUrl: string } }).signoz.baseUrl).toBe(
      'http://fallback:8080',
    );
  });

  it('falls back to the env shim on an unknown backend name', () => {
    writeProjectConfig({ backend: 'tempo' }); // future variant, not in v0.2.0
    expect(loadConfig('default', projectRoot).backendConfig.backend).toBe('signoz');
  });

  it('readProjectBackendConfig returns undefined when no file exists', () => {
    expect(readProjectBackendConfig(projectRoot)).toBeUndefined();
  });
});

describe('doctor backend check with embedded config', () => {
  it('checks the collector binary instead of probing SigNoz', async () => {
    writeProjectConfig({ backend: 'embedded' });
    const ctx: DoctorContext = { cwd: projectRoot, projectRoot };
    const result = await signozReachable(ctx);
    // Pass/fail depends on whether the binary is installed on this machine;
    // the contract is that the check is about the collector, not SigNoz.
    expect(result.name).toContain('Embedded collector');
  });

  it('still probes SigNoz when no project config exists', async () => {
    const ctx: DoctorContext = { cwd: projectRoot, projectRoot };
    const result = await signozReachable(ctx);
    expect(result.name).toContain('SigNoz');
  });
});
