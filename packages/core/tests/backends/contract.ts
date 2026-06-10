import { describe, it, expect } from 'vitest';
import type { EvidenceBackend, WaitForTraceOptions } from '../../src/backends/interface.js';
import { TraceOnError } from '../../src/errors.js';

/**
 * Reusable EvidenceBackend conformance suite. Every backend implementation
 * (SigNoz now; embedded collector in the embedded-backend phase) is driven
 * through the same assertions so behavior doesn't silently diverge.
 *
 * The fixture is responsible for seeding the backend so `traceId` resolves to
 * at least one span and one log, and for fast settle timings so the suite
 * doesn't wait real seconds.
 */
export interface ContractFixture {
  name: string;
  /** Construct a backend seeded so `traceId` has >=1 span and >=1 log. */
  makeBackend(): EvidenceBackend | Promise<EvidenceBackend>;
  traceId: string;
  /** Fast settle options so the suite runs in milliseconds. */
  waitOpts?: WaitForTraceOptions;
  /** Optional per-test cleanup (stop a temp server, delete temp files, etc.). */
  teardown?(): void | Promise<void>;
}

export function runBackendContract(fx: ContractFixture): void {
  describe(`EvidenceBackend contract: ${fx.name}`, () => {
    async function withBackend(fn: (b: EvidenceBackend) => Promise<void>): Promise<void> {
      const b = await fx.makeBackend();
      try {
        await fn(b);
      } finally {
        await b.close();
        await fx.teardown?.();
      }
    }

    it('reports healthy when reachable', async () => {
      await withBackend(async (b) => {
        expect((await b.health()).ok).toBe(true);
      });
    });

    it('waitForTrace settles once spans stop arriving', async () => {
      await withBackend(async (b) => {
        const r = await b.waitForTrace(fx.traceId, fx.waitOpts);
        expect(r.complete).toBe(true);
      });
    });

    it('fetchSpans returns normalized spans for the trace', async () => {
      await withBackend(async (b) => {
        const spans = await b.fetchSpans(fx.traceId);
        expect(spans.length).toBeGreaterThan(0);
        const s = spans[0]!;
        expect(s.trace_id).toBe(fx.traceId);
        expect(typeof s.span_id).toBe('string');
        expect(s.span_id.length).toBeGreaterThan(0);
        expect(['OK', 'ERROR', 'UNSET']).toContain(s.status);
        expect(typeof s.start_ts).toBe('number');
        expect(typeof s.duration_ms).toBe('number');
      });
    });

    it('fetchLogs returns normalized logs for the trace window', async () => {
      await withBackend(async (b) => {
        const logs = await b.fetchLogs(fx.traceId, { startMs: 0, endMs: 8.64e15 });
        expect(Array.isArray(logs)).toBe(true);
        if (logs.length > 0) {
          const l = logs[0]!;
          expect(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).toContain(l.level);
          expect(typeof l.body).toBe('string');
        }
      });
    });

    it('unreachableError is a TraceOnError', async () => {
      await withBackend(async (b) => {
        expect(b.unreachableError()).toBeInstanceOf(TraceOnError);
      });
    });

    it('close is idempotent', async () => {
      const b = await fx.makeBackend();
      await b.close();
      await expect(b.close()).resolves.toBeUndefined();
      await fx.teardown?.();
    });
  });
}
