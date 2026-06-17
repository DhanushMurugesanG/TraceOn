import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_OTLP_PORT,
  EmbeddedCollector,
  collectorPaths,
  generateCollectorConfig,
  isPortInUse,
  waitForPortReady,
} from '../../src/backends/embedded/collector.js';
import { collectorBinaryPath } from '../../src/backends/embedded/binary.js';
import { TraceOnError } from '../../src/errors.js';

function listen(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

// High ports unlikely to collide with anything on a dev machine or CI.
const TEST_PORT = 41947;

describe('generateCollectorConfig', () => {
  it('wires one OTLP receiver into separate trace and log file pipelines', () => {
    const cfg = generateCollectorConfig('/data/dir', 5555);
    expect(cfg).toContain('endpoint: "127.0.0.1:5555"');
    // Paths are emitted as quoted YAML scalars (JSON.stringify) so spaces /
    // colons in a custom dataDir can't break the config.
    expect(cfg).toContain(`path: ${JSON.stringify(join('/data/dir', 'traces.ndjson'))}`);
    expect(cfg).toContain(`path: ${JSON.stringify(join('/data/dir', 'logs.ndjson'))}`);
    expect(cfg).toContain('format: json');
    // Both pipelines present — logs parity with SigNoz is load-bearing.
    expect(cfg).toMatch(/traces:\s*\n\s*receivers: \[otlp\]\s*\n\s*exporters: \[file\/traces\]/);
    expect(cfg).toMatch(/logs:\s*\n\s*receivers: \[otlp\]\s*\n\s*exporters: \[file\/logs\]/);
  });

  it('defaults to port 4319 (adjacent to OTel standard 4318)', () => {
    expect(DEFAULT_OTLP_PORT).toBe(4319);
    expect(generateCollectorConfig('/d')).toContain('endpoint: "127.0.0.1:4319"');
  });

  it('quotes paths so a dataDir with spaces/colons stays valid YAML', () => {
    const weird = '/Users/me/Library/Application Support/trace:on';
    const cfg = generateCollectorConfig(weird, 4319);
    // The exact quoted path must appear; no bare colon/space that would make
    // the YAML scalar parse short.
    expect(cfg).toContain(`path: ${JSON.stringify(join(weird, 'traces.ndjson'))}`);
    expect(cfg).not.toContain(`path: ${join(weird, 'traces.ndjson')}\n`);
  });

  it('derives all paths from the data dir', () => {
    const p = collectorPaths('/d');
    expect(p).toEqual({
      config: join('/d', 'collector.yaml'),
      tracesFile: join('/d', 'traces.ndjson'),
      logsFile: join('/d', 'logs.ndjson'),
      logFile: join('/d', 'collector.log'),
    });
  });
});

describe('isPortInUse', () => {
  it('detects a listening server', async () => {
    const srv = await listen(TEST_PORT);
    try {
      expect(await isPortInUse(TEST_PORT)).toBe(true);
    } finally {
      srv.close();
    }
  });

  it('reports a free port as not in use', async () => {
    expect(await isPortInUse(TEST_PORT + 1)).toBe(false);
  });
});

describe('waitForPortReady', () => {
  it('resolves once the port starts accepting', async () => {
    const srv = await listen(TEST_PORT + 2);
    try {
      await expect(
        waitForPortReady(TEST_PORT + 2, { timeoutMs: 2_000, pollMs: 10 }),
      ).resolves.toBeUndefined();
    } finally {
      srv.close();
    }
  });

  it('throws EMBEDDED_COLLECTOR_DOWN when the process dies during startup', async () => {
    try {
      await waitForPortReady(TEST_PORT + 3, {
        timeoutMs: 2_000,
        pollMs: 10,
        isProcessAlive: () => false,
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(TraceOnError);
      expect((e as TraceOnError).code).toBe('EMBEDDED_COLLECTOR_DOWN');
      expect((e as TraceOnError).message).toContain('exited during startup');
    }
  });

  it('throws EMBEDDED_COLLECTOR_DOWN on ready timeout', async () => {
    try {
      await waitForPortReady(TEST_PORT + 4, { timeoutMs: 50, pollMs: 10 });
      expect.unreachable();
    } catch (e) {
      expect((e as TraceOnError).code).toBe('EMBEDDED_COLLECTOR_DOWN');
      expect((e as TraceOnError).message).toContain('did not become ready');
    }
  });
});

describe('EmbeddedCollector', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'traceon-collector-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('refuses to start when the port is busy', async () => {
    const srv = await listen(TEST_PORT + 5);
    const collector = new EmbeddedCollector({
      binaryPath: '/nonexistent',
      dataDir,
      port: TEST_PORT + 5,
    });
    try {
      await expect(collector.start()).rejects.toMatchObject({ code: 'EMBEDDED_PORT_BUSY' });
    } finally {
      srv.close();
    }
  });

  it('surfaces a dead-on-arrival binary as EMBEDDED_COLLECTOR_SPAWN_FAILED with the cause', async () => {
    // Spawning a nonexistent path emits an async 'error' event (ENOENT); the
    // readiness poll must convert that into a structured spawn-failed error
    // carrying the real cause, not a generic "exited during startup".
    const collector = new EmbeddedCollector({
      binaryPath: join(dataDir, 'does-not-exist'),
      dataDir,
      port: TEST_PORT + 6,
      readyTimeoutMs: 2_000,
    });
    await expect(collector.start()).rejects.toMatchObject({
      code: 'EMBEDDED_COLLECTOR_SPAWN_FAILED',
    });
  });

  it('stop() is idempotent and safe before start', async () => {
    const collector = new EmbeddedCollector({
      binaryPath: '/nonexistent',
      dataDir,
      port: TEST_PORT + 7,
    });
    await expect(collector.stop()).resolves.toBeUndefined();
    await expect(collector.stop()).resolves.toBeUndefined();
  });

  // A tiny executable Node script that listens like a collector would —
  // exercises spawn → ready-poll → graceful stop without the 364MB binary.
  function writeFakeCollector(port: number): string {
    const shim = join(dataDir, 'fake-collector.js');
    writeFileSync(
      shim,
      `#!/usr/bin/env node\nrequire('net').createServer().listen(${port}, '127.0.0.1');\nsetInterval(() => {}, 1000);\n`,
    );
    chmodSync(shim, 0o755);
    return shim;
  }

  it('starts, manages, and SIGTERMs a real long-running process', async () => {
    const collector = new EmbeddedCollector({
      binaryPath: writeFakeCollector(TEST_PORT + 8),
      dataDir,
      port: TEST_PORT + 8,
      readyTimeoutMs: 5_000,
    });
    await collector.start();
    expect(collector.isAlive()).toBe(true);
    expect(existsSync(collectorPaths(dataDir).config)).toBe(true);
    expect(readFileSync(collectorPaths(dataDir).config, 'utf-8')).toContain(
      `127.0.0.1:${TEST_PORT + 8}`,
    );
    await collector.stop();
    expect(collector.isAlive()).toBe(false);
    // double-stop after a real run is also fine
    await expect(collector.stop()).resolves.toBeUndefined();
  });

  it('start() is a no-op when already running', async () => {
    const collector = new EmbeddedCollector({
      binaryPath: writeFakeCollector(TEST_PORT + 9),
      dataDir,
      port: TEST_PORT + 9,
      readyTimeoutMs: 5_000,
    });
    await collector.start();
    try {
      await expect(collector.start()).resolves.toBeUndefined();
      expect(collector.isAlive()).toBe(true);
    } finally {
      await collector.stop();
    }
  });
});

// Live round-trip against the real pinned binary. Skipped unless the
// developer opts in (TRACEON_E2E=1) AND the binary is already installed —
// CI never downloads 95MB for unit tests.
const realBinary = collectorBinaryPath(join(homedir(), '.traceon', 'bin'));
const e2e = process.env['TRACEON_E2E'] === '1' && existsSync(realBinary);

describe.skipIf(!e2e)('EmbeddedCollector (live otelcol-contrib)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'traceon-collector-e2e-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('spawns the real collector, accepts OTLP, shuts down cleanly', async () => {
    const port = TEST_PORT + 20;
    const collector = new EmbeddedCollector({
      binaryPath: realBinary,
      dataDir,
      port,
      readyTimeoutMs: 15_000,
    });
    await collector.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/traces`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resourceSpans: [] }),
      });
      expect(res.ok).toBe(true);
    } finally {
      await collector.stop();
    }
    expect(collector.isAlive()).toBe(false);
  }, 30_000);
});
