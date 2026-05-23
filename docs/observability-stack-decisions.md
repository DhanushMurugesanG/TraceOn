# Observability stack decisions

## Why SigNoz over alternatives

### What we chose

**SigNoz** as the trace and log backend for v1. Single Docker compose, self-hosted, free, handles both traces and logs.

### What we rejected

We evaluated several alternatives before picking SigNoz. None of them are *bad*; SigNoz just fit the v1 constraints best.

**Jaeger (rejected for v1)**

Pros: industry standard for traces, lightweight, well-documented.
Cons: handles traces only. Logs need a separate backend (Loki, Elasticsearch). That's two services to manage, two query APIs to integrate against, two failure modes to debug. Doubles the surface area.

When this might change: if TraceOn ever supports trace-only verification (no log correlation), Jaeger becomes attractive. Not v1.

**Tempo + Loki + Grafana (rejected)**

Pros: Grafana-stack alignment, well-supported by Grafana Labs, scales horizontally.
Cons: three separate services to run. Each has its own config, its own resource needs, its own failure modes. For a solo developer running this locally, the operational overhead isn't worth the scale benefits we won't use.

When this might change: if TraceOn ever runs in production environments where horizontal scaling matters. Not v1.

**Honeycomb (rejected)**

Pros: best-in-class trace exploration UX, generous free tier for individuals.
Cons: cloud service. Violates invariant I3 (all data stays on developer's machine). Also adds an external dependency that could go down, change pricing, or get acquired.

When this might change: never. The invariant about local-only data is core to the product. Honeycomb integration could exist as an opt-in connector in v2+, but the default stays local.

**Datadog / New Relic (rejected)**

Pros: enterprise-grade, well-known.
Cons: expensive, requires accounts, violates local-only invariant. Same reasoning as Honeycomb.

**Custom SQLite-based storage (rejected)**

Pros: zero external dependencies, fastest possible local query.
Cons: TraceOn would have to implement its own OTLP receiver, trace storage, trace querying. Weeks of work to replicate what SigNoz gives us for free. Not the right place to spend solo build time.

### Why SigNoz wins for v1

1. **One container.** `docker compose up` and the whole observability stack is running. Trace receiver, log receiver, storage, query API, UI — one command.
2. **Both traces and logs.** TraceOn correlates both. Having them in one system means one query interface for both signals.
3. **OTLP-native.** No translation layer between OpenTelemetry's wire format and SigNoz's storage. The exporter just works.
4. **Local and free.** Fits invariant I3, no cost concerns.
5. **Open source.** Can be inspected, modified, replaced.
6. **The connector is isolated.** TraceOn's architecture puts the SigNoz integration in `packages/core/src/connectors/signoz.ts`. Adding a Jaeger or Tempo connector later is a localized change.

### What we know is uncertain about SigNoz

A few risks worth tracking:

**1. SigNoz's HTTP API changes between versions.** Looking at the v1 build, the agent had to inspect actual responses to write the normalization layer. If we upgrade SigNoz, that layer might need rework. Pin the SigNoz version in docker-compose to avoid surprises.

**2. The UI is on port 8080, not 3301.** The PRD was written assuming an older SigNoz default. Current SigNoz uses 8080. Fixed.

**3. SigNoz handles trace propagation correctly for HTTP services but other protocols may need explicit OTel instrumentation.** For TraceOn v1 (browser → backend HTTP), this isn't an issue. For future multi-protocol scenarios (gRPC, queues), test before assuming.

---

## OpenTelemetry decisions

### Why W3C `traceparent`, not custom headers

The W3C Trace Context standard defines `traceparent` as the universal header for propagating trace IDs. OpenTelemetry's auto-instrumentation handles `traceparent` automatically — read on incoming, forward on outgoing.

Using a custom header (like `X-TraceOn-Trace-Id`) would mean writing our own propagation logic in every service. Using `traceparent` means OTel does it for free.

Invariant I1: `traceparent` is the only correlation primitive TraceOn uses.

### Why auto-instrumentation, not manual

OpenTelemetry has two modes: auto-instrumentation (libraries wrap HTTP, Express, etc. automatically) and manual (developer adds spans explicitly).

We use auto-instrumentation because:
1. It captures more than we'd think to capture manually
2. It works on any Node.js app without code changes — important for TraceOn's sample app and future user apps
3. It correctly handles trace propagation across libraries

Trade-off: span names follow OTel conventions, not custom names. This is fine. The semantic conventions are well-designed.

### The `code.filepath` attribute for coverage

OpenTelemetry's semantic conventions include `code.filepath` — the source file where a span was created. Auto-instrumentation populates this automatically for most spans.

TraceOn uses this for the coverage check: "did any span come from a changed file?" If yes, the file was exercised. If no, the file may not have run during the test.

This is what makes Scenario 05 (the silent failure mode) detectable. Without `code.filepath`, you couldn't distinguish "test ran but didn't touch the change" from "test ran and touched the change."

### Service naming convention

The OTel resource attribute `service.name` identifies which service emitted a span. We use the convention `traceon-<role>-<service>`:

- `traceon-sample-backend` for the sample app's backend
- `traceon-sample-frontend` for the sample app's frontend (if instrumented)
- `traceon-spike-backend` for the spike

User projects will use their own service names. TraceOn doesn't enforce a naming scheme — it just reads whatever `service.name` is present.

---

## Why Node 22+ and TypeScript end-to-end

### Node 22+

Modern Node features TraceOn uses:
- Native ESM (no transpilation needed for `import`/`export`)
- `--import` flag for instrumentation bootstrap (replaced `--require`)
- Native test runner (we use Vitest, but Node's built-in is good for ad-hoc testing)
- Improved performance

Older Node versions would work but with friction. Pinning to 22+ avoids that friction.

### TypeScript end-to-end

The entire codebase is TypeScript:
- Core types in `@traceon/core`
- MCP server in `@traceon/mcp`
- Playwright fixture in `@traceon/playwright`

Reasons:
1. **Type safety across the trace_id correlation primitive.** A `TraceId` is a 32-hex string. A `RunId` is a ULID. Mixing them would be a bug. Types prevent this at compile time.
2. **Shared types between packages.** Without TypeScript, the MCP server and the ranker would have to maintain duplicate type definitions for `RawEvidence`, `RankedPacket`, etc. With it, one definition flows everywhere.
3. **Better Claude Code support.** When Claude Code reads the codebase to make changes, types tell it what's allowed. Looser typing = worse agent behavior.

### Why not Go or Rust

Both would be defensible. Go has better OTel auto-instrumentation. Rust has better performance. Neither matters enough to justify the cognitive cost of context-switching languages on a solo evening build.

The sample app could be in Go for v2 (better OTel auto-instrumentation for Go users). For v1, TypeScript is the right choice because it minimizes the languages the solo builder has to keep in their head.

## v1.1 candidates from first real test (2026-05-23)

From failure-path testing on the spike:

1. **60s trace wait for frontend-only tests.** `waitForTraceComplete` waits
   the full `maxWaitMs: 60_000` even when no backend spans will ever arrive.
   Fix: expose `max_wait_ms` per call, or short-circuit when browser events
   show no network activity.

2. **ANSI codes in failure messages.** Playwright's failure output contains
   terminal color codes (`\u001b[2m` etc.) that reach the agent as noise.
   Fix: strip ANSI in the result serializer before the ranker receives it.

3. **`incomplete: true` is ambiguous.** Currently fires for both "trace was
   truncated mid-flight" and "no trace activity at all." Skill decision rules
   can't distinguish without reading deeper evidence.
   Fix: add `incomplete_reason: "truncated" | "no_activity"` to the result.

4. **Coverage empty when only test file in `changed_files`.** Test files are
   filtered out by the `.spec.` pattern, so passing just the test produces
   empty coverage with no explanation.
   Fix: skill guidance — always pass implementation files, not test files, in
   `changed_files`. Or: coverage should explain why hits/misses are empty.
