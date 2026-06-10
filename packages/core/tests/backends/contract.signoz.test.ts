import { beforeEach, afterEach, vi } from 'vitest';
import { SigNozClient } from '../../src/backends/signoz.js';
import { runBackendContract } from './contract.js';

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const BASE_URL = 'http://signoz.test:8080';

// Minimal SigNoz /api/v3/query_range list payloads, in the shape
// normalizeSpans / normalizeLogs expect.
function tracesResponse() {
  return {
    status: 'success',
    data: {
      result: [
        {
          queryName: 'A',
          list: [
            {
              timestamp: '2023-11-14T22:13:20Z',
              data: {
                spanID: 'a1b2c3d4e5f60718',
                traceID: TRACE_ID,
                name: 'POST /checkout',
                serviceName: 'checkout',
                startTimeUnixNano: '1700000000000000000',
                durationNano: 5_000_000,
                statusCode: 1,
                responseStatusCode: 200,
              },
            },
          ],
        },
      ],
    },
  };
}

function logsResponse() {
  return {
    status: 'success',
    data: {
      result: [
        {
          queryName: 'A',
          list: [
            {
              timestamp: '2023-11-14T22:13:20Z',
              data: {
                timestamp: 1_700_000_000_000,
                severity_text: 'error',
                body: 'payment gateway timed out',
                trace_id: TRACE_ID,
                span_id: 'a1b2c3d4e5f60718',
                'service.name': 'checkout',
              },
            },
          ],
        },
      ],
    },
  };
}

function installFetchMock() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: { body?: BodyInit | null }) => {
      const u = String(url);
      if (u.endsWith('/api/v1/version')) {
        return new Response(JSON.stringify({ version: 'v0.test' }), { status: 200 });
      }
      if (u.endsWith('/api/v3/query_range')) {
        const body = JSON.parse(String(init?.body ?? '{}'));
        const dataSource = body?.compositeQuery?.builderQueries?.A?.dataSource;
        const payload = dataSource === 'logs' ? logsResponse() : tracesResponse();
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }),
  );
}

beforeEach(() => installFetchMock());
afterEach(() => vi.unstubAllGlobals());

runBackendContract({
  name: 'SigNoz (mocked HTTP)',
  makeBackend: () => new SigNozClient({ baseUrl: BASE_URL }),
  traceId: TRACE_ID,
  // Tiny timings so waitForTrace settles in ~10ms instead of seconds.
  waitOpts: { maxWaitMs: 1_000, stabilityMs: 1, pollMs: 5 },
});
