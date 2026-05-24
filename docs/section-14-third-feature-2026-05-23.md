# Section 14 — third scenario: summary history feature

**Date:** 2026-05-23
**Scenario:** Fresh Claude implements summary history from scratch — POST /api/summarize stores each summary, GET /api/summaries returns newest-first, frontend renders the recent 5 with auto-update.
**Outcome:** `test_status: "passed"`, surfaced to user on coverage warning per skill rules.

## What fresh Claude did

1. Read the prompt, immediately recognized "this crosses frontend and backend with observable behavior and an explicit ordering concern — exactly what TraceOn is for." Loaded the skill from the description alone.
2. Implemented across three files: `backend/server.js` (history array + new endpoint + push-on-summarize), `frontend/src/App.tsx` (useEffect on mount, fetchHistory after summarize, list rendering capped at 5), `tests/summary-history.spec.ts` (3 distinct timestamped summarizes, assertions on ordering and cap).
3. **Pre-flighted the backend restart** unprompted — killed `lsof -ti:3001 | xargs kill`, restarted with the OTel `--import`, and verified via curl that ordering was correct ("bbb before aaa") **before** calling `traceon_verify`. This wasn't in the skill — Claude inferred it from "Node doesn't hot-reload."
4. Called `traceon_verify` with all three changed files.
5. Got `test_status: passed`, 32 OK spans, 0 errors, `incomplete: false`, but coverage warnings for both backend and frontend files.
6. Surfaced to the user per the "passes but coverage warning" skill rule, with the prescribed framing — did not auto-declare done.

## What this proves

- **Skill discovery works** from MCP tool description without prompting.
- **The decision rules are consistent across fresh sessions** — same surfacing framing, same three options presented, same honest reasoning ("strong corroborating evidence... but the rules still say I shouldn't unilaterally wave through") as the char_count run.
- **Rich evidence path works.** Unlike the failure-path test where the trace was empty (no fetch fired), this run had 32 OK spans across multiple endpoints. The `intent_hint.relevant_spans` actually populated with matching span IDs.
- **Backend restart inference is reliable.** This was a real worry going into the test. Claude handled it cleanly without skill guidance.

## What the coverage warning told us (again)

Same OTel file-attribution false alarm as the char_count run. The test asserted on the rendered DOM (which is populated only by the real GET response) and the backend ordering was independently curl-verified. The change definitely ran. The warning fires because individual source files don't emit their own spans — OTel attributes HTTP work to the route/framework.

This is the second time in two runs the warning has fired as a false alarm. Now actionable v1.1 input.

## What this scenario did NOT exercise

- **Iteration on a fresh Claude session.** Feature passed cleanly. We still don't know whether fresh Claude correctly applies the "failed with cause in changed code → iterate" rule, the "don't modify the test" constraint, or the 3-iteration cap.
- **Tier 1 / Tier 2 evidence at scale.** Empty in this run because no failures.

## Section 14 status

| PRD criterion | Status |
|---|---|
| Skill triggers in sample app | ✅ |
| Claude follows the workflow | ✅ |
| Decision rules produce consistent behavior across ≥3 features | ✅ (3 scenarios, 2 by fresh Claude with consistent surfacing) |
| **Iteration on failure proven** | ⚠️ **still untested in a fresh session** |

Technically meets the PRD criterion. Iteration is an honest gap — closing it before Section 15 would strengthen the foundation.

## v1.1 candidates raised by this scenario

- Coverage warning needs to distinguish "OTel file attribution gap" from "code genuinely didn't run." Right now agents must manually reason through it on every passing-with-coverage-warning result. Could be a heuristic (if the test asserts on a fetch response, downgrade the warning) or a separate signal (`coverage.attribution_limited` boolean).
- MCP server could optionally automate backend restart between iterations. Not urgent — Claude handled it manually — but it's a friction point worth noting.
