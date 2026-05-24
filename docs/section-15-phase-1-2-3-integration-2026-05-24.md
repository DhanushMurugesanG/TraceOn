# Section 15 — Phase 1+2+3 end-to-end integration test

**Date:** 2026-05-24
**Commits exercised:** `7747db0` (15.1) → `1bfc369` (15.2) → `b09374b` (15.3) → `0584f1b` (15.1.1 hotfix)

## What was tested

Three scenarios exercising the new flags and error paths:

| # | Scenario | Tests | Outcome |
|---|---|---|---|
| A | UI-only test (`char-count.spec.ts`) — types into textarea, asserts on DOM, no fetch | Phase 1's `no_trace_activity` skip | ✅ passed in 1489ms (was ~70s pre-Phase-1), `no_trace_activity: true`, all error counts zero |
| B | Network-active test (`summary-history.spec.ts`) — fires 4 fetches against backend | Phase 1's `attribution_limited` flag + SigNoz round-trip | ✅ passed in 3095ms, 32 OK spans, `no_trace_activity: false`, `attribution_limited: true`, new warning text fired |
| C | Induced `TRACE_BACKEND_UNREACHABLE` (SigNoz down) | Phase 2's structured error end-to-end | Skipped at user direction; code-inspected: signoz.health() → gather.ts throws TraceOnError → mcp/index.ts catches → returns `isError: true` with structured payload → SKILL.md has per-code branch at line 366. Chain is wired correctly. |

## What this proves

- **Phase 1 works** — `no_trace_activity` correctly skips the 60s SigNoz wait when the test fires no responses; the timing improvement is real (~46× faster on UI-only tests).
- **`attribution_limited` works** — fires when execution evidence (spans) exists but file attribution doesn't; the new warning text actually mentions the OTel gap so even a skill-less agent gets the signal.
- **Phase 2's TraceOnError chain is intact** — every link grep-verified end-to-end.
- **Phase 3 is loaded** in both copies of SKILL.md and aligned with the new flags.

## What was caught and fixed during testing

**Bug found in Phase 1:** the `hasNetworkActivity` check in `gather.ts` was using `browser_events.jsonl` entries with `kind: "network"` as the signal, but the Playwright fixture was only logging network events for **failed** responses (status ≥ 400). So any happy-path test that hit the backend successfully had zero network events logged, was misclassified as UI-only, and skipped SigNoz round-trips entirely.

Fix: `Section 15.1.1` (`0584f1b`) — log all responses regardless of status. Six lines changed in `packages/playwright-fixture/src/index.ts`.

The bug is exactly the kind end-to-end testing exists to catch. Phase 1's `no_trace_activity` claim was overstated until 15.1.1 landed — only true for tests with *zero* responses, not the broader "tests that didn't hit the backend" category I'd assumed.

## What's still not tested

- **Live Scenario C** — code path verified by inspection only. The user can run `docker stop signoz && [verify call] && docker start signoz` later if they want a live exercise.
- **Iteration on failure in a fresh Claude session** — still the open Section 14 gap. Phase 5 (demo recording) is the natural place to test this; the demo's Act 2 is the iteration scenario.
- **`RANKER_TIER1_OVERFLOW`** — would need a scenario with cascading backend failures to trip the budget. Out of scope for now.

## Updated v1.1 candidates (raised by this test)

- The new attribution-gap warning text is informative but verbose. Could be a structured field on `CoverageInfo` rather than baked into the warning string.
- `RANKER_TIER1_OVERFLOW` is the only error code with no live test path. A unit test against a synthetic over-budget RawEvidence input would close that gap cheaply.

## State after this test

| Phase | Status |
|---|---|
| 15.1 (UX papercuts) | ✅ + 15.1.1 hotfix |
| 15.2 (structured errors) | ✅ |
| 15.3 (skill update) | ✅ |
| 15.4 (README) | next |
| 15.5 (demo video) | after README |
