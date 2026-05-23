# First failure-path test — observations

**Date:** 2026-05-23
**Run ID:** `01KSA4MVB11QRUUXW4TAXA2G`
**Trace ID:** `aa2f35d3d3f272d4bfa835bdc93f0f7a`
**Evidence path:** `.traceon/runs/01KSA4MVB11QRUUXW4TAXA2G`

## Scenario

Seeded a `text.length * 2` bug in the spike's character counter (frontend-only). Ran `traceon_verify` against a Playwright test that types `hello` (5 chars) and asserts the counter shows `"5 characters"`. Test was expected to fail with the counter showing `"10 characters"`.

## Result

`test_status: "failed"` — correctly identified. One Tier 1 item: the failed assertion.

Tier 1 summary contained:
```
Expected: "5 characters"
Received: "10 characters"
Locator:  [data-testid=char-counter]
```

A reader can identify the bug from this one line without looking at code.

Budget used: **484 / 50 000** tokens. Tier 2 empty. Tier 3 empty.

## What worked

- Tier 1 captured the failed assertion with a smoking-gun message
- Locator AND actual rendered DOM value both surfaced in the message
- Token budget extremely tight — ranker did its job
- `intent_hint.note` honestly reported "No spans or logs matched the stated intent" rather than fabricating a match
- Evidence directory persisted to disk; the run is fully inspectable after the fact

## What needs work

1. **60s wait on traces that will never arrive.** The frontend-only test never clicks Summarize, so no fetch, so no backend trace. `waitForTraceComplete` waited the full `maxWaitMs: 60_000` looking for stable spans that don't exist. Added ~60s to the call for zero benefit. Possible fix: short-circuit when the Playwright fixture's `browser_events.jsonl` shows zero network events, or expose `max_wait_ms` per call.

2. **Coverage was empty** because `changed_files` was just the test file (skipped by the `.spec.` filter). Technically correct, but means coverage gives no signal in the "just verify existing functionality" scenario. The skill should probably tell the agent to pass the implementation files too — or coverage should explain *why* hits/misses are empty.

3. **Failure message contains ANSI color codes** (`[2m`, `[31m`, etc.). Readable but ugly when fed to the agent. Worth stripping in the Playwright result parser before it reaches the ranker.

4. **`incomplete: true` is ambiguous.** Same flag fires for "trace was truncated" and "no trace activity occurred." The skill's decision rules would benefit from distinguishing these.

## What this run didn't test

- Iteration: the run stopped before fix-and-reverify. Branches A/B/C of the failure plan untested.
- Backend bugs: failure was frontend-only.
- Coverage with real `changed_files`: implementation file wasn't passed.
- Cross-service evidence: no fetch occurred, so no spans to correlate.

## v1.1 candidates

- Per-call `max_wait_ms` to short-circuit no-trace-expected scenarios.
- ANSI strip in the result serializer.
- Distinguish "incomplete: trace truncated" from "incomplete: no trace activity."
- Skill guidance: pass implementation files in `changed_files` even when "just verifying", so coverage can speak.

## Bottom line

One data point. The failure path works at the evidence-capture level. The harder half — iteration on the failure, fix-and-reverify, skill-driven decision rules — is still untested. Section 14 (the skill) and the wait-time UX are the next things to look at when picking this back up.
