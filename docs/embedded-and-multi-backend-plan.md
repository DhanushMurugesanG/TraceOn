# Plan — embedded mode + multi-backend support

The architectural plan to address the recurring "setup friction is brutal"
feedback ([first-run-experience.md](first-run-experience.md),
[feedback-2026-05-26.md](feedback-2026-05-26.md),
[feedback-2026-05-26-round-2.md](feedback-2026-05-26-round-2.md)) and the
strategic question "do we have to require SigNoz."

Combines **Path C** (embedded mode — TraceOn is its own minimal OTel
collector, no SigNoz needed) with **Path B** (multi-backend support —
Tempo, Jaeger, Datadog, Honeycomb for users who already have observability
infra). Path C first because it future-proofs Path B: once we have a clean
`EvidenceBackend` interface the embedded store implements, adding external
backends becomes cheaper.

## Goals

1. **Default setup goes from ~8 steps to ~2.** New users run
   `npm i -g traceon-cli && traceon init` and the only manual step is
   pointing their OTel exporter at TraceOn's local port. No Docker, no
   SigNoz install, no API key prompts.
2. **Existing observability stacks aren't displaced.** Users who already
   run SigNoz / Tempo / Datadog can keep using them via a connector
   choice in `traceon init`.
3. **Backward compatible.** v0.0.x SigNoz configs keep working unchanged
   through at least v0.2.x.

## Non-goals

- Becoming a general-purpose observability backend. The embedded store
  is per-run, transient, single-machine. No UI, no long-term retention,
  no multi-tenancy.
- Auto-instrumenting the user's backend. The user is still responsible
  for OTel SDK setup in their code; we're a destination, not a profiler.
- Replacing production observability. Embedded mode is for dev/test/CI;
  production keeps its existing stack.

## How TraceOn handles OpenTelemetry today

Important baseline for the plan below.

TraceOn does NOT generate OTel data and does NOT instrument the user's app.
The user's backend is already OTel-instrumented (their job). Today's flow:

```
                       ┌─────────────────┐
                       │   Playwright    │
                       │   (in browser)  │
                       └────────┬────────┘
                                │ traceparent: 00-<traceId>-...
                                │ (injected by traceon-fixture.js)
                                ▼
                       ┌─────────────────┐
                       │  User's backend │
                       │  (their OTel    │
                       │   SDK)          │
                       └────────┬────────┘
                                │ OTLP export
                                ▼
                       ┌─────────────────┐         ┌──────────────────┐
                       │     SigNoz      │ ◄────── │   TraceOn MCP    │
                       │ (storage + UI)  │  query  │   (queries by    │
                       └─────────────────┘  by ID  │    traceId)      │
                                                   └──────────────────┘
```

TraceOn's only OTel work is: (a) generate a trace id, (b) inject
`traceparent` via the Playwright fixture, (c) query whatever backend
the user has for spans tagged with that id.

The change in this plan: replace step (c)'s "query SigNoz" with "query a
pluggable `EvidenceBackend` interface" where SigNoz is one of N
implementations. The new default implementation is **embedded** — an
OTel collector running inside the MCP server, receiving spans pushed
straight from the user's backend, no external service required.

## Triggering — "is there any other way to trigger?"

The full alternatives matrix for how spans reach TraceOn:

| Mechanism | How it works | Pros | Cons | Verdict |
|---|---|---|---|---|
| **OTLP push to embedded (Phase 1)** | User points backend OTel exporter at TraceOn's port; we receive OTLP/HTTP and store in-process. | Zero extra services. One env var to change in the backend. | One config change in the user's OTel bootstrap. | **Default path.** |
| **Dual exporter** | User keeps existing OTel exporters (SigNoz / Tempo / etc.) AND adds a second exporter target pointed at TraceOn. OTel SDKs support multiple processors natively. | Zero disruption to existing production observability. Opt-in per-environment (e.g., only export to TraceOn in dev). | Adds one block to OTel SDK bootstrap code. | **Recommended for production-shaped apps.** Doc, don't build — works on Phase 1 without further changes. |
| **OTel Collector sidecar** | Ship `traceon-collector` binary preconfigured to receive OTLP and fan out to both the user's backend AND TraceOn. User changes SDK exporter to point at the sidecar. | Single config change. Compatible with all downstream backends. | We maintain another binary; users run another process. | Optional, lower priority. Skip unless requested. |
| **OTel zero-code agents** | Use Java/Node/Python auto-instrumentation agents that hook the runtime. | Often no code changes. | Per-language, version-fragile, not all stacks. | Optional add-on. Document patterns, don't ship the agents. |
| **HTTP proxy interception** | TraceOn proxies HTTP between browser and backend, captures req/res. | No backend code changes. | Misses backend-internal spans (DB queries, intra-service calls) — defeats half of TraceOn's value. | **Skip.** Too lossy. |
| **eBPF kernel capture** | eBPF probes capture all HTTP traffic kernel-side. | No code changes anywhere. | Linux-only, root required, misses app-level context (logger output, business spans). | **Skip for now.** Niche. |
| **Stdout log scraping** | Watch backend stdout for structured JSON logs (pino, zap, structlog). | Trivial to set up. | Captures logs only, not spans. Limited evidence. | Could be a complementary signal later. Not a replacement for traces. |

**Two triggers, one implementation.** Phase 1 (embedded OTLP receiver)
supports both "direct push" and "dual exporter" — they're the same
plumbing on TraceOn's side, only the user's OTel SDK config differs.
That's two ergonomic paths for free.

## Phases

### Phase 0 — interface refactor (1 week)

Pure cleanup; no user-visible change. Pulls the SigNoz-specific code
out of paths it leaks into, behind a common `EvidenceBackend` interface
so the rest of the codebase doesn't care which backend it's talking to.

**Deliverables:**

- `packages/core/src/backends/interface.ts` — define the interface:

  ```ts
  export interface EvidenceBackend {
    /** Wait for all spans with this traceId to settle, return raw evidence. */
    waitForTrace(traceId: string, opts: WaitForTraceOptions): Promise<RawEvidence>;
    /** Release any resources (close servers, db connections, etc.). */
    close(): Promise<void>;
  }
  ```

- Move existing `SigNozClient` to `packages/core/src/backends/signoz.ts`
  implementing `EvidenceBackend`.
- Update `packages/mcp/src/verify.ts` to use the interface, not the
  concrete class. Backend selected via config.
- `loadConfig` returns a `{ backend: 'signoz', ... }` discriminated
  union. Today only `signoz`; placeholder for `embedded`, `tempo`,
  `jaeger`, etc.
- Vitest contract tests in `packages/core/tests/backends/` — any
  implementation passes the same suite.

**Risk:** low. Pure refactor.
**Ships as:** v0.1.0 (minor bump for interface change; no user behavior
diff for SigNoz users).

### Phase 1 — embedded OTLP collector (1.5–2 weeks)

The big one. TraceOn embeds a minimal OTLP/HTTP receiver. The user's
backend exports spans to TraceOn directly. SigNoz becomes optional.

**Deliverables:**

- `packages/core/src/backends/embedded/server.ts` — OTLP/HTTP receiver.
  Listens on a configurable port (default 4319 — adjacent to OTel's 4318
  to avoid collisions). Uses `@opentelemetry/otlp-transformer` for the
  protobuf decode so we don't hand-roll OTLP parsing.
- `packages/core/src/backends/embedded/store.ts` — SQLite store, indexed
  by `trace_id`. Auto-cleanup on each verify call: drop spans older than
  configurable TTL (default 1h). Cross-process visible so multi-instance
  scenarios don't drop data.
- `packages/core/src/backends/embedded/client.ts` — implements
  `EvidenceBackend` over the local store. `waitForTrace` polls the store
  with the same settle-detection logic as SigNoz today.
- `bin/cli.js` — `traceon init` adds a backend-choice branch:
  - "Embedded (recommended — no extra setup)" → writes `backend: 'embedded'`
    config block + a snippet for the user's OTel SDK config
  - "Bring your own backend (SigNoz / Tempo / Jaeger / etc.)" → existing
    flow, plus newcomers added in Phase 2
- `skills/traceon-verify/SKILL.md` — short addition: agents reading the
  evidence packet don't need to know which backend produced it (interface
  hides the difference); the difference matters only at `traceon init` time.
- `docs/embedded-mode-setup.md` — single-page setup guide with per-language
  OTel SDK config snippets (Node, Go, Python at minimum).
- README updated: embedded becomes the default path; SigNoz moves down to
  "Bring your own backend" section.

**Decisions baked in:**

- **OTLP/HTTP only** in v1, not gRPC. HTTP is enough for the use case and
  simpler to ship; gRPC adds protobuf-over-HTTP/2 plumbing that's overkill
  for a per-run dev tool.
- **SQLite for the store** so the MCP server can spawn helper processes
  (e.g. for cleanup) without losing data. In-memory wouldn't survive a
  server restart mid-run.
- **Default cleanup:** spans older than 1h are dropped at verify time.
  Explicit `traceon clear-cache` subcommand for nuking everything.
- **Port choice:** configurable, default 4319. We probe at init time and
  warn if the port is busy.

**Risk:** medium. OTLP parsing is non-trivial but well-covered by the
upstream library. Span-settle heuristics need to be carefully matched to
the existing SigNoz behavior so the agent's experience doesn't shift.

**Ships as:** v0.2.0. Embedded becomes the default for new `traceon init`
runs; existing SigNoz configs continue to work untouched.

### Phase 2 — Tempo + Jaeger (1 week)

Use the interface from Phase 0 to wire up two more backends. Targets the
"I already have Tempo behind Grafana" and "we run Jaeger" crowds.

**Deliverables:**

- `packages/core/src/backends/tempo.ts` — Tempo HTTP query API client.
  Single-trace fetch via `/api/traces/<id>`, parses the (very different)
  Tempo response shape into the common `RawEvidence` type.
- `packages/core/src/backends/jaeger.ts` — Jaeger HTTP API client.
  Similar shape to Tempo; older and more stable protocol.
- Config schemas + `traceon init` prompts updated.
- Tests against recorded HTTP fixtures (no live Tempo/Jaeger required in CI).
- README + docs updated with per-backend setup snippets.

**Risk:** low for Jaeger. Medium for Tempo — pagination needed for large
traces, response shape is its own thing.

**Ships as:** v0.3.0.

### Phase 3 — Datadog + Honeycomb (1 week)

Paid SaaS backends. Lower priority. Ship if users ask.

**Deliverables:**

- `packages/core/src/backends/datadog.ts` — uses
  `/api/v2/spans/events/search`, requires API key + app key headers.
- `packages/core/src/backends/honeycomb.ts` — uses Honeycomb's Query
  Result API (async — submit query, poll for results). More complex than
  Datadog.
- Config schema + prompts.

**Risk:** medium. Both have paywalls and rate limits; recorded-fixture
testing keeps CI clean but live testing is a pain.

**Ships as:** v0.4.0.

### Phase 4 — polish & migration (3–4 days)

- Migration guide: "you're on a v0.0.x SigNoz config; here's how to
  switch to embedded mode if you want to."
- Per-language OTel SDK setup snippets in `docs/`. At minimum: Node, Go,
  Python. Optionally: Java, Rust, .NET.
- Update the [traceon-site](https://github.com/DhanushMurugesanG/traceon-site)
  landing page Get-started stepper — embedded mode means the SigNoz
  install step in the current stepper goes away for most users.
- The Handy kit on the site gets a new card for the dual-exporter pattern.

**Risk:** low.
**Ships as:** v0.4.x patch.

## Schema additions

New top-level config shape after Phase 0:

```jsonc
// .traceon/config.json
{
  "backend": "embedded",        // or "signoz" | "tempo" | "jaeger" | "datadog" | "honeycomb"
  "embedded": {
    "port": 4319,               // OTLP/HTTP receiver port
    "spanTtlMs": 3_600_000,     // cleanup window (1h)
    "dbPath": ".traceon/cache.sqlite"
  },
  "signoz": {                   // present only if backend === "signoz"
    "baseUrl": "http://localhost:8080",
    "apiKey": "${SIGNOZ_API_KEY}"
  }
  // tempo / jaeger / datadog / honeycomb blocks added in Phase 2/3
}
```

`traceon init` writes only the block matching the chosen backend; the
rest are absent. Pre-Phase-0 SigNoz configs in `claude_desktop_config.json`
keep working — the MCP server's bootstrap derives a `backend: 'signoz'`
config if no explicit backend is named.

## Risks & uncertainty register

| Risk | Likelihood | Mitigation |
|---|---|---|
| OTLP protobuf parsing eats more time than planned | Medium | Use `@opentelemetry/otlp-transformer` instead of hand-rolling. If it doesn't work cleanly, swap to `protobufjs` with the OTLP `.proto` files. |
| SQLite store grows unbounded | Low | TTL-based cleanup on every verify call; `traceon clear-cache` for nuke. |
| Port conflicts with the user's actual services | Medium | Configurable; default to 4319; probe at init time and warn. |
| Phase 0 refactor breaks v0.0.x users | Medium | Hold-over shim: when no explicit `backend` field is present, derive `backend: 'signoz'` from legacy SigNoz config keys. Drop the shim in v1.0.0. |
| Span-settle heuristic differs from SigNoz's behavior | Medium | Vitest contract tests run the same scenarios against both backends; if behavior diverges, document. |
| Maintaining 5+ backend connectors is unfun over time | High over time | Recorded HTTP fixtures (no live backends in CI). Each backend's surface area is small (~one or two endpoints). |
| Embedded mode lacks the SigNoz UI for ad-hoc exploration | Medium | Acceptable trade — users who need the UI keep SigNoz as their backend. Document this in the migration guide. |

## Timeline & shipping cadence

Earliest shippable points:

| Version | Phase | What changed | Timeline |
|---|---|---|---|
| v0.1.0 | After Phase 0 | Interface refactor. No user-visible diff. | ~1 week |
| v0.2.0 | After Phase 1 | **Embedded mode is the default.** Eliminates Docker/SigNoz setup for new users. | ~2.5–3 weeks total |
| v0.3.0 | After Phase 2 | Tempo + Jaeger connectors. | ~3.5–4 weeks total |
| v0.4.0 | After Phase 3 | Datadog + Honeycomb. | ~5 weeks total |
| v0.4.x | After Phase 4 | Polish, migration guides, site updates. | ~5.5 weeks total |

The single highest-leverage release is **v0.2.0** — that's the one that
addresses the recurring "setup friction" complaint and makes TraceOn
something a new user can adopt without an afternoon-long evaluation
session.

## What does NOT need to ship as part of this plan

These are independent improvements that the feedback flagged but don't
require the backend rework:

- `traceon doctor` preflight check (from feedback-round-1)
- Skill-staleness version stamp (from feedback-round-2)
- Coverage warning denoising (from feedback-round-1)
- Ranker improvement to deprioritise background errors (round-2)

These can ship between phases as small patches if they're blocking real
users.

## Open questions for the user

1. **Should embedded mode be the default in `traceon init` (recommended),
   or should we ask "do you have an existing observability backend?" as
   the first question?** The recommended-default path is faster for the
   majority case; the explicit-ask path is more discoverable.
2. **Do we want to ship a `traceon-collector` sidecar binary in Phase 1,
   or keep direct-OTLP-to-MCP as the only ingestion path?** The sidecar
   adds operational complexity but enables the dual-exporter pattern
   without the user editing their OTel SDK code.
3. **What's the minimum language coverage for Phase 4 OTel SDK setup
   snippets?** Node + Go is a small project; add Python for ML/data
   teams; Java/Rust/.NET are aspirational.
4. **Do we need a `traceon clear-cache` subcommand in Phase 1, or is
   TTL-based cleanup on every verify run sufficient?** TTL alone is
   simpler but leaves stale data around between sessions.

These are real forks; pick before Phase 0 starts.
