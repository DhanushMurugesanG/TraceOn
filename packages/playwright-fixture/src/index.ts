import { test as base } from '@playwright/test';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomBytes } from 'crypto';

interface TraceOnFixtures {
  traceonContext: void;
}

function appendEvent(path: string, event: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + '\n');
}

export const test = base.extend<TraceOnFixtures>({
  traceonContext: [
    async ({ context, page }, use) => {
      const traceId = process.env['TRACEON_TRACE_ID'];
      const evidenceDir = process.env['TRACEON_EVIDENCE_DIR'];

      // Not running under TraceOn — act as a passthrough so tests still work.
      if (!traceId || !evidenceDir) {
        await use();
        return;
      }

      const spanId = randomBytes(8).toString('hex');
      const eventsPath = `${evidenceDir}/browser_events.jsonl`;

      await context.setExtraHTTPHeaders({
        traceparent: `00-${traceId}-${spanId}-01`,
      });

      page.on('console', (msg) => {
        appendEvent(eventsPath, {
          kind: 'console',
          ts: Date.now(),
          level: msg.type(),
          text: msg.text(),
        });
      });

      page.on('pageerror', (err) => {
        appendEvent(eventsPath, {
          kind: 'page_error',
          ts: Date.now(),
          text: err.message,
          stack: err.stack,
        });
      });

      page.on('requestfailed', (request) => {
        appendEvent(eventsPath, {
          kind: 'network',
          ts: Date.now(),
          url: request.url(),
          failure: request.failure()?.errorText,
        });
      });

      page.on('response', (response) => {
        appendEvent(eventsPath, {
          kind: 'network',
          ts: Date.now(),
          url: response.url(),
          status: response.status(),
        });
      });

      await use();
    },
    { auto: true },
  ],
});

export { expect } from '@playwright/test';
