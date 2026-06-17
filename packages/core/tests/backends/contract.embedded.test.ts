import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EmbeddedBackend, type CollectorLike } from '../../src/backends/embedded/client.js';
import { collectorPaths } from '../../src/backends/embedded/collector.js';
import { runBackendContract } from './contract.js';

const FIXTURES = join(__dirname, '..', 'fixtures', 'embedded');
const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';

class StubCollector implements CollectorLike {
  alive = false;
  started = 0;
  stopped = 0;
  readonly port = 4319;
  async start(): Promise<void> {
    this.alive = true;
    this.started++;
  }
  async stop(): Promise<void> {
    this.alive = false;
    this.stopped++;
  }
  isAlive(): boolean {
    return this.alive;
  }
}

// ---------------------------------------------------------------------------
// The same conformance suite SigNoz passes, against the embedded backend
// reading real File-exporter fixtures. This is the "backends don't diverge"
// guarantee from the plan's risk register.
// ---------------------------------------------------------------------------
const contractDirs: string[] = [];
runBackendContract({
  name: 'Embedded (File-exporter fixtures)',
  traceId: TRACE_ID,
  waitOpts: { maxWaitMs: 1_000, stabilityMs: 1, pollMs: 5 },
  makeBackend: () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'traceon-embedded-contract-'));
    contractDirs.push(dataDir);
    const p = collectorPaths(dataDir);
    copyFileSync(join(FIXTURES, 'traces.ndjson'), p.tracesFile);
    copyFileSync(join(FIXTURES, 'logs.ndjson'), p.logsFile);
    const collector = new StubCollector();
    collector.alive = true;
    return new EmbeddedBackend(collector, dataDir);
  },
  teardown: () => {
    for (const d of contractDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  },
});

// ---------------------------------------------------------------------------
// Embedded-specific behavior beyond the shared contract.
// ---------------------------------------------------------------------------
describe('EmbeddedBackend specifics', () => {
  let dataDir: string;
  let collector: StubCollector;
  let backend: EmbeddedBackend;

  function spanLine(spanId: string, traceId = TRACE_ID): string {
    return (
      JSON.stringify({
        resourceSpans: [
          {
            resource: { attributes: [] },
            scopeSpans: [{ scope: {}, spans: [{ traceId, spanId, name: 'n' }] }],
          },
        ],
      }) + '\n'
    );
  }

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'traceon-embedded-'));
    collector = new StubCollector();
    backend = new EmbeddedBackend(collector, dataDir, {
      maxWaitMs: 300,
      stabilityMs: 30,
      pollMs: 5,
    });
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('start() clears stale output files, then brings the collector up', async () => {
    writeFileSync(backend.tracesFile, spanLine('aa'));
    writeFileSync(backend.logsFile, 'stale\n');
    await backend.start();
    expect(existsSync(backend.tracesFile)).toBe(false);
    expect(existsSync(backend.logsFile)).toBe(false);
    expect(collector.started).toBe(1);
    expect((await backend.health()).ok).toBe(true);
  });

  it('start() does NOT clear files when the collector is already running', async () => {
    await backend.start();
    writeFileSync(backend.tracesFile, spanLine('aa'));
    await backend.start(); // e.g. second verify in the same server lifetime
    expect(existsSync(backend.tracesFile)).toBe(true);
  });

  it('waitForTrace settles once the per-trace span count stops growing', async () => {
    await backend.start();
    writeFileSync(backend.tracesFile, spanLine('01'));
    // Simulate the collector appending while we wait.
    const appender = setTimeout(() => {
      writeFileSync(backend.tracesFile, spanLine('01') + spanLine('02'));
    }, 20);
    const result = await backend.waitForTrace(TRACE_ID);
    clearTimeout(appender);
    expect(result.complete).toBe(true);
    expect(await backend.fetchSpans(TRACE_ID)).toHaveLength(2);
  });

  it('returns complete:false at maxWaitMs when no spans ever arrive (incomplete, not error)', async () => {
    await backend.start();
    const result = await backend.waitForTrace(TRACE_ID);
    expect(result.complete).toBe(false);
  });

  it('ignores spans from other traces when counting stability', async () => {
    await backend.start();
    writeFileSync(
      backend.tracesFile,
      spanLine('01') + spanLine('aa', 'ffffffffffffffffffffffffffffffff'),
    );
    const result = await backend.waitForTrace(TRACE_ID);
    expect(result.complete).toBe(true);
    expect(await backend.fetchSpans(TRACE_ID)).toHaveLength(1);
  });

  it('throws EMBEDDED_COLLECTOR_DOWN if the collector dies mid-wait', async () => {
    await backend.start();
    writeFileSync(backend.tracesFile, spanLine('01'));
    setTimeout(() => {
      collector.alive = false;
    }, 15);
    await expect(
      backend.waitForTrace(TRACE_ID, { maxWaitMs: 5_000, stabilityMs: 4_000, pollMs: 5 }),
    ).rejects.toMatchObject({ code: 'EMBEDDED_COLLECTOR_DOWN' });
  });

  it('fetchLogs filters by trace id AND time window (SigNoz parity)', async () => {
    await backend.start();
    const logLine = (ts: string, traceId: string) =>
      JSON.stringify({
        resourceLogs: [
          {
            resource: { attributes: [] },
            scopeLogs: [
              {
                scope: {},
                logRecords: [{ timeUnixNano: ts, body: { stringValue: 'x' }, traceId }],
              },
            ],
          },
        ],
      }) + '\n';
    writeFileSync(
      backend.logsFile,
      logLine('1700000000000000000', TRACE_ID) + // in window
        logLine('1800000000000000000', TRACE_ID) + // out of window
        logLine('1700000000000000000', 'ffffffffffffffffffffffffffffffff'), // other trace
    );
    const logs = await backend.fetchLogs(TRACE_ID, {
      startMs: 1_699_999_999_000,
      endMs: 1_700_000_001_000,
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.trace_id).toBe(TRACE_ID);
  });

  it('fetchSpans/fetchLogs return [] when output files do not exist yet', async () => {
    await backend.start();
    expect(await backend.fetchSpans(TRACE_ID)).toEqual([]);
    expect(await backend.fetchLogs(TRACE_ID, { startMs: 0, endMs: 1 })).toEqual([]);
  });

  it('health reflects collector liveness; unreachableError keeps the shared code', async () => {
    expect((await backend.health()).ok).toBe(false);
    await backend.start();
    expect((await backend.health()).ok).toBe(true);
    expect(backend.unreachableError().code).toBe('TRACE_BACKEND_UNREACHABLE');
  });

  it('per-verify close() does NOT stop the server-lifetime collector', async () => {
    await backend.start();
    await backend.close();
    expect(collector.isAlive()).toBe(true);
    expect(collector.stopped).toBe(0);
  });
});

describe('getEmbeddedBackend singleton', () => {
  it('reuses one instance per process and stops it on shutdown', async () => {
    // Import fresh to keep this test self-contained with the module state.
    const { getEmbeddedBackend, shutdownEmbeddedBackend } = await import(
      '../../src/backends/embedded/client.js'
    );
    const dataDir = mkdtempSync(join(tmpdir(), 'traceon-embedded-singleton-'));
    try {
      const ensureBinary = async () => '/fake/otelcol';
      const a = await getEmbeddedBackend({ dataDir, ensureBinary });
      const b = await getEmbeddedBackend({ dataDir, ensureBinary });
      expect(a).toBe(b);
      // shutdown is a no-op-safe teardown even though start() never ran
      await shutdownEmbeddedBackend();
      const c = await getEmbeddedBackend({ dataDir, ensureBinary });
      expect(c).not.toBe(a);
      await shutdownEmbeddedBackend();
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rebuilds (not reuses) the backend when a different project config arrives', async () => {
    const { getEmbeddedBackend, shutdownEmbeddedBackend } = await import(
      '../../src/backends/embedded/client.js'
    );
    const dirA = mkdtempSync(join(tmpdir(), 'traceon-embedded-projA-'));
    const dirB = mkdtempSync(join(tmpdir(), 'traceon-embedded-projB-'));
    const ensureBinary = async () => '/fake/otelcol';
    try {
      const a = await getEmbeddedBackend({ dataDir: dirA, port: 4319, ensureBinary });
      // Same config → same instance.
      expect(await getEmbeddedBackend({ dataDir: dirA, port: 4319, ensureBinary })).toBe(a);
      // Different port → must NOT silently reuse project A's collector.
      const b = await getEmbeddedBackend({ dataDir: dirB, port: 4400, ensureBinary });
      expect(b).not.toBe(a);
      expect(b.tracesFile).toContain('projB');
      await shutdownEmbeddedBackend();
    } finally {
      rmSync(dirA, { recursive: true, force: true });
      rmSync(dirB, { recursive: true, force: true });
    }
  });
});
