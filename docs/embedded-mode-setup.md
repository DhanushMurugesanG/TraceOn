# Embedded mode setup

Embedded mode (default since v0.2.0) means TraceOn runs its own OTel
Collector — no Docker, no SigNoz, no API key. `traceon init` downloads the
collector once (~95 MB, checksum-verified, into `~/.traceon/bin/`); the MCP
server starts it lazily on the first `traceon_verify` call and stops it on
shutdown.

The only manual step: your backend's OTel SDK must export OTLP to TraceOn's
local port (default **4319**).

## How it works

```
Playwright (browser) ── traceparent ──▶ Your backend (OTel SDK)
                                              │ OTLP/HTTP push
                                              ▼
                                   TraceOn's collector (:4319)
                                   (otelcol-contrib subprocess)
                                              │ File exporter (NDJSON)
                                              ▼
                                     TraceOn MCP ── evidence ──▶ Claude
```

TraceOn waits for the trace to settle (span count stable for 10s, max 60s —
tunable via `embedded.settle` in `.traceon/config.json`), parses the
collector's output, and builds the same evidence packet the SigNoz backend
produces.

## Pointing your backend at TraceOn

The standard OTel env vars work with every SDK; no code changes needed if
your bootstrap doesn't hardcode the endpoint:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4319
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

### Node.js

```js
// instrumentation.js — run with: node --import ./instrumentation.js server.js
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: 'http://localhost:4319/v1/traces',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();
```

### Go

```go
import (
    "go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
    "go.opentelemetry.io/otel/sdk/trace"
)

exporter, err := otlptracehttp.New(ctx,
    otlptracehttp.WithEndpoint("localhost:4319"),
    otlptracehttp.WithInsecure(),
)
tp := trace.NewTracerProvider(trace.WithBatcher(exporter))
```

### Python

```python
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(
    OTLPSpanExporter(endpoint="http://localhost:4319/v1/traces")
))
trace.set_tracer_provider(provider)
```

### Python / FastAPI: code.filepath attribution

FastAPI/ASGI OTel auto-instrumentation doesn't set `code.filepath` on spans by
default, so TraceOn can't map spans back to specific Python source files.
Changed backend files then show up in `coverage.misses` with
`coverage.attribution_limited: true`.

This is an upstream `opentelemetry-python-contrib` limitation, not a TraceOn
bug. The spans themselves (HTTP, DB, etc.) still arrive and are ranked
normally — only *file-level* coverage attribution is affected.

**What to do: usually nothing.** TraceOn flags this (`attribution_limited`), and
the skill knows to treat those misses as low-confidence and verify the change
by asserting on the response body — which your Playwright test already does. No
action is needed for most users.

**Optional** — if you need true file-level attribution, set `code.filepath`
yourself via manual instrumentation, or a custom `SpanProcessor` whose
`on_start` sets `span.set_attribute("code.filepath", <path>)`.

## Dual exporter — keep your existing observability

If your backend already exports to SigNoz / Tempo / Datadog, don't replace
that — add TraceOn as a **second** exporter. OTel SDKs support multiple span
processors natively:

```js
// Node example: production exporter + TraceOn, side by side
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';

const sdk = new NodeSDK({
  spanProcessors: [
    new BatchSpanProcessor(new OTLPTraceExporter({ url: 'https://your-stack/v1/traces' })),
    new BatchSpanProcessor(new OTLPTraceExporter({ url: 'http://localhost:4319/v1/traces' })),
  ],
  instrumentations: [getNodeAutoInstrumentations()],
});
```

Gate the TraceOn processor behind an env check (`NODE_ENV === 'development'`)
so production builds don't try to reach a local port.

## Config reference

`.traceon/config.json` (written by `traceon init`):

```jsonc
{
  "backend": "embedded",
  "embedded": {
    "port": 4319,            // OTLP/HTTP receiver port
    "dataDir": "...",        // optional; default ~/.traceon/embedded
    "settle": {
      "maxWaitMs": 60000,    // hard ceiling on the trace-settle wait
      "stabilityMs": 10000,  // settled = span count unchanged this long
      "pollMs": 2000         // poll cadence
    }
  }
}
```

## Troubleshooting

- **`traceon doctor`** checks the collector binary install (among the other
  preflights).
- **No backend spans in evidence** — confirm your backend exports to :4319
  (look for exporter errors in your backend's stderr), and that CORS allows
  `traceparent` if frontend and backend are on different origins (same
  requirement as SigNoz mode; see [auth-and-cors-setup.md](auth-and-cors-setup.md)).
- **Port 4319 already in use** — set a different `embedded.port` and update
  your backend's exporter endpoint to match.
- **Collector log** — `~/.traceon/embedded/collector.log` has the collector's
  own stderr (bad config, port bind failures).
- **Logs in evidence are empty** — embedded mode captures OTLP *logs* only if
  your SDK exports them (most trace-only setups don't). Span evidence is
  unaffected.

## Switching from SigNoz

Re-run `traceon init` and pick Embedded — it writes `.traceon/config.json`,
which takes precedence over the env-var SigNoz config in your Claude MCP
registration. To go back, delete `.traceon/config.json` (env-var SigNoz
config resumes) or re-run `init` and pick SigNoz. Your SigNoz install and
data are untouched either way.
