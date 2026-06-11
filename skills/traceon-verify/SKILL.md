---
name: traceon-verify
version: 0.2.0
description: Use this skill when implementing or fixing user-facing features in projects that have TraceOn configured. Trigger words include "add", "implement", "build", "create", "fix bug in", or any feature work where behavior changes are observable in a running application. Use it especially when the change crosses frontend and backend, where visual confirmation isn't enough.
---

# Verifying changes with TraceOn

## Overview

TraceOn is a runtime verification tool. After you implement a change,
TraceOn runs the test you wrote against the actual application, captures
real evidence from the running system (backend traces, logs, browser
events), and returns a structured `VerificationResult` you reason over.

This is different from "the test passed." A test can pass for the wrong
reason — a stale UI element, a cached response, a code path that didn't
actually run. TraceOn's evidence tells you what really happened in the
runtime, not just what the test saw. Your job is to read that evidence
honestly, not to declare done based on the green checkmark alone.

The MCP tool you call is `traceon_verify`. The result it returns contains
the truth of what happened. Trust the evidence over your own assumptions.

## The workflow

When the user asks for a feature, behavior change, or bug fix where
runtime verification applies:

### 1. Implement the change

Write the implementation as you normally would. Frontend, backend, or
both depending on what the change requires.

### 2. Write a Playwright test

Write a Playwright test that exercises the feature end-to-end. The test
should:

- Open the relevant UI page
- Perform the user's actions (clicks, form fills, navigation)
- Reach an assertion that confirms the expected behavior
- Wrap each user action in `test.step()` so the evidence is readable
- Use stable selectors like `data-testid`, not CSS classes
- Make real HTTP requests — do NOT mock the backend, TraceOn needs
  actual backend evidence

Example structure (the fixture file is dropped into `tests/` by
`traceon init` — import it as a relative path):

```typescript
import { test, expect } from './traceon-fixture.js';

test('feature works end to end', async ({ page }) => {
  await test.step('Navigate to feature', async () => {
    await page.goto('/feature');
  });

  await test.step('Perform user action', async () => {
    await page.locator('[data-testid=action-btn]').click();
  });

  await test.step('Verify outcome', async () => {
    await expect(page.locator('[data-testid=outcome]')).toBeVisible();
  });
});
```

### 3. Commit implementation and test together

Use a clear commit message describing the change. Both the implementation
and test should land in the same commit so it's clear what was being
verified.

### 4. Call traceon_verify

Pass three things:

- `test`: the absolute path to the test file you wrote
- `intent`: the user's request in your own words, one sentence
- `changed_files`: every file you modified (implementation AND test)

If the test needs environment variables (e.g. an `AUTH_TOKEN` for a
protected route, or a `BASE_URL` override), pass them via `extra_env`:

```json
{
  "test": "/abs/path/to/test.spec.ts",
  "intent": "verify the user can save as draft",
  "changed_files": ["..."],
  "extra_env": { "AUTH_TOKEN": "ey...", "BASE_URL": "http://localhost:3004" }
}
```

`extra_env` keys are forwarded to the Playwright subprocess as real env
vars — your test can read them via `process.env.AUTH_TOKEN`. **Do not
read auth from `process.env` directly without also passing `extra_env`**:
the test runs in a child process that doesn't inherit your shell env.

For tokens you want to persist across runs without re-passing them every
call, see the "Auth lifecycle" section under Special cases below.

If this is a retry, also pass:

- `iteration_index`: which attempt this is (1, 2, or 3)
- `prior_run_id`: the `run_id` from the previous attempt

### 5. Read the VerificationResult

The result has these key fields:

- `test_status`: passed, failed, timedOut, or interrupted
- `evidence_summary`: counts of error spans, error logs, HTTP failures
- `coverage`: which changed files had spans (proof of execution)
- `ranked_packet`: ranked evidence the agent should reason over
- `intent_hint`: notes on whether the test exercised the stated intent

### 6. Decide based on the result

Apply the decision rules below. Each rule is a specific condition mapping
to a specific action.

## Decision rules

### When the test passes cleanly

If all of these are true:

- `test_status === "passed"`
- `evidence_summary.tier1_count === 0`
- `coverage.warnings.length === 0`
- `evidence_summary.incomplete === false`

**Declare done.** Tell the user what was verified, specifically:

> Feature implemented and verified. The test ran in [duration] and
> exercised [N] backend operations. No errors detected.
>
> Evidence at: [evidence_path]

Be specific about what was verified. "Verified" alone isn't useful — the
user wants to know what TraceOn actually saw.

### When the test passes with no network activity (UI-only test)

If `test_status === "passed"` AND `evidence_summary.no_trace_activity === true`:

This is a UI-only test that never fired a backend request. Common cases:

- Adding or removing a static UI element
- Local state behavior — filters, toggles, validation messages
- Pure CSS or styling changes
- Component-level interactions that don't reach the network

What you'll typically see in the evidence:

- 0 spans (the trace is empty by design)
- 0 errors of every flavor
- `coverage.warnings` may reference backend files in `changed_files` —
  ignore those, since no backend was exercised
- `coverage.attribution_limited === false` (nothing to attribute either way)
- The verify call returns in ~2 seconds rather than waiting 60s for a
  trace that will never arrive

If `evidence_summary.tier1_count === 0`:

**Declare done** with a brief note that backend tracing wasn't exercised:

> Verified. The test was UI-only — no fetches fired, so backend tracing
> didn't activate. That's expected for changes that don't cross frontend
> and backend.
>
> Evidence at: [evidence_path]

If `tier1_count > 0` (page errors caught by the browser-side fixture
without any network call), apply the "failed with a clear cause" rules
below to the items in Tier 1.

### When the test passes but coverage shows misses

If `test_status === "passed"` AND `coverage.warnings.length > 0`,
**check `coverage.attribution_limited` first**.

> Note (v0.0.11+): frontend files (`.tsx`, `.jsx`, `.vue`, `.svelte`,
> and `.ts`/`.js` under typical frontend `src/` paths) no longer appear
> in `coverage.misses` or `coverage.warnings` at all — they're listed
> in `coverage.info` instead as benign signals. If you see a single
> `coverage.info` line saying "N frontend files in changed_files —
> no backend spans expected", that's the tool telling you "I know about
> these and they're fine, no need to reason about them." Don't treat
> `info` as a concern.

#### Case A: `coverage.attribution_limited === true`

The warning is almost certainly the **OpenTelemetry file-attribution
gap**, not a real missed code path. Execution evidence exists (the trace
has spans), but file-level attribution didn't fire — this is a known
OpenTelemetry limitation where backend spans are attributed to the
route/framework, not to the specific source file that ran.

If the test asserted on a real response body or on DOM populated by a
real fetch, the changed code clearly ran. The warning is a false alarm.

**Declare done** with a brief note acknowledging the attribution gap:

> Verified. The change ran end-to-end — the test asserted on real
> response data and TraceOn saw [N] spans across the call. Coverage
> attribution didn't light up for [file], but that's the known OpenTelemetry
> file-attribution gap, not a missed code path.
>
> Evidence at: [evidence_path]

Do NOT surface this case to the user as an open question. The evidence
is sufficient; surfacing every time creates noise that erodes trust in
TraceOn's signals.

#### Case B: `coverage.attribution_limited === false`

The warning is a **real miss** — no execution evidence at all for the
changed code. This is the silent failure mode TraceOn exists to catch.

This typically means one of:

- The test asserted on UI state but didn't trigger the changed code path
- The frontend served a cached or stubbed value without calling the
  backend
- The test exercised a different code path than the one you modified

**Do not declare done.** Surface to the user with three options:

> The test passed, but I'm not confident your change was exercised.
> Specifically:
> - [paste the exact warnings from coverage.warnings]
>
> The test ran and the UI behaved correctly, but the runtime evidence
> doesn't show [the changed file] being invoked at all — and there's no
> attribution-gap caveat to explain it away.
>
> How would you like to proceed?
> 1. Trust the green test and consider this done
> 2. Update the test to exercise [the changed file] more directly
> 3. Investigate manually before proceeding

Wait for the user's choice. Do not auto-select option 1 even if the
result looks correct to you.

### When the test failed with a clear cause in your changed code

If `test_status === "failed"` AND `ranked_packet.tier1` contains errors
whose attributes indicate they came from code you modified:

**Iterate.** Read the Tier 1 evidence carefully. Identify the root cause
from the error span, error log, or HTTP 5xx response. Then:

- Edit the implementation to fix the issue
- Do NOT modify the test (see "What NOT to do" below)
- Call `traceon_verify` again with `iteration_index: 2` (or 3)

If iteration_index is already 3 when this rule applies, see the "Three
failed iterations" rule below instead.

### When the test failed but errors are in code you didn't change

If `test_status === "failed"` AND `ranked_packet.tier1` contains errors
in services or files NOT in `changed_files`:

**Surface to the user.** The failure is likely environmental — a
dependency broke, a service is down, an unrelated regression surfaced.
Auto-iterating would mean modifying code that wasn't part of your task.

Use this framing:

> Tests failed but the errors are in [service or file], which I didn't
> modify in this change. Specifically:
> - [paste relevant Tier 1 evidence]
>
> This looks environmental rather than a bug in my change. How should
> I proceed?
> 1. Treat as environmental and assume my change is fine
> 2. Investigate the failing service before continuing
> 3. Something else

### When a testid you just added doesn't appear (bundle staleness)

If `test_status === "failed"` AND the Tier 1 failure is a selector not
found — specifically a `data-testid` you ADDED in the implementation
in this same change — there's a third possibility beyond "test wrong"
and "code wrong": **your dev server is one rebuild behind your editor.**

Vite / Webpack / module-federation builds have an HMR settling window
where the bundle served at the test URL is the pre-edit version even
though the new code is on disk and typechecked. The browser sees the
old DOM; your test sees the new DOM in source; both are right.

**Cheap first response:** if `iteration_index < 3`, do **one blind
retry** of `traceon_verify` without changing the code. Retries are
fast (often ~4 s) and an HMR-settled rerun will pass without any
intervention. This is the lowest-cost diagnostic you have for this
case.

If the retry also fails on the same selector, THEN suspect the code.
Check the source for the testid (you have Read access to the test and
the implementation file) before iterating on the implementation:

```typescript
// Quick first-line assertion before the wizard navigates:
const src = await fs.readFile('src/.../VisibilityRow.tsx', 'utf-8');
if (!src.includes('vis-internal-row-employee')) {
  throw new Error('Implementation file does not contain the testid. The change may have been reverted or never landed.');
}
```

This catches **state-drift between sessions** — file rolled back, edit
lost in an aborted save, branch switched — in milliseconds instead of
routing through Playwright navigation + selector timeout (5-20 s of
wasted wallclock).

Use this framing when surfacing to the user after a retry + source
check both fail:

> The test expected `data-testid="X"` but the served bundle didn't have
> it. I retried (HMR settling) and also read the source file — the
> testid isn't there either. Either the implementation file was reverted
> between sessions, or I never actually added it. Should I re-add the
> code change?

### When the test timed out

If `test_status === "timedOut"`:

**Read `test_summary.failure_message` FIRST.** As of v0.0.8 it leads with
the specific step that was running when the timeout fired and the file
location, e.g.:

```
Timed out at step 13/14: "Click Save Draft" (tests/save.spec.ts:42:7).
Last action error: locator.fill: Target page, context or browser has
been closed. Test timeout of 180000ms exceeded.
```

That's almost always actionable — the step name + the per-step error
together usually name the cause (a hanging fill, a missing selector,
a never-resolving promise).

**Then check the evidence:**

- If `evidence_summary.error_spans > 0`: a backend operation also
  errored during the run. Read Tier 1 for that error; the timeout and
  the error are likely related (e.g. backend hung, frontend waited).
- If `evidence_summary.error_spans === 0`: usually async behavior the
  test didn't account for. Common causes:
  - A queue worker or background job didn't complete in time
  - A webhook didn't fire as expected
  - A polling consumer ran longer than the test timeout
  - The feature is genuinely async and the test was too strict on timing

Use this framing when surfacing to the user:

> The test timed out at step [N]: "[step title]" ([file:line]). The
> last action was [paste the lastStepError or the step title].
>
> [If error_spans > 0:] The backend also errored during this run with
> [Tier 1 summary] — likely related.
> [If error_spans === 0:] No backend error spans, so this looks like
> async behavior the test didn't wait for.
>
> [Then ask the right question:]
> Was [the failing action] expected to complete synchronously?

Do not iterate blindly on a timeout. The step context tells you where;
the user tells you whether the wait was wrong or the code was.

### When the trace was incomplete

If `evidence_summary.incomplete === true`:

**Surface to the user, regardless of test_status.** An incomplete trace
means TraceOn's polling timed out before the trace settled — late
evidence may have been missed. Even a passing test with incomplete
evidence is suspect.

Use this framing:

> The test [passed/failed], but the trace evidence is incomplete — some
> backend spans may not have arrived in time. This usually means slow
> services or async work still in progress when verification ended.
>
> Would you like me to investigate further, or treat the visible
> evidence as sufficient?

Do not silently retry. Retrying with the same timeout won't help if the
system is genuinely slow, and would mask the timing issue from the user.

### When the same failure happens three times

If `iteration_index === 3` AND `test_status === "failed"` (or timed out):

**Stop iterating. Surface to the user with the full iteration history.**

Three failed iterations on the same problem usually means the agent's
mental model of the problem is wrong, not that more attempts will work.
A human review can spot the conceptual error faster than the agent can
fix it through more grinding.

Use this framing:

> I've attempted this fix three times and hit similar failures each
> time. My approach may be wrong.
>
> Iteration history:
> - Iteration 1: [brief summary of what I tried and what failed]
> - Iteration 2: [brief summary]
> - Iteration 3: [brief summary]
>
> Most recent failure evidence:
> - [Tier 1 summary]
>
> Could you take a look? I think I'm misunderstanding something about
> [the area of code or the failure pattern].

Do not call `traceon_verify` a fourth time without explicit user
direction.

### When the tool itself errors

If the tool result is `{ isError: true }` and `content[0].text` parses
as JSON with shape `{ code, message, userGuidance }`, you've hit a
structured TraceOn error. **Match on `code`** and apply the per-code
framing below. Do NOT attempt to fix the infrastructure yourself
unless the user explicitly approves.

#### `code === "TEST_FILE_NOT_FOUND"`

The test path you passed doesn't exist on disk. Either the path was
wrong, the test wasn't saved, or it's in a different directory.

Surface:

> The test file I passed doesn't exist:
> - [message]
> - [userGuidance]
>
> Did you mean a different path, or should I look for the test elsewhere
> in the repo?

#### `code === "PLAYWRIGHT_SPAWN_FAILED"`

Playwright isn't installed in the project, or `pnpm` is missing from
PATH. Environment setup issue, not a code issue.

Surface:

> I can't run the test because Playwright isn't available:
> - [message]
> - [userGuidance]
>
> Once Playwright is installed, ask me to retry the verification.

Do NOT run `pnpm add -D @playwright/test` yourself unless the user
explicitly approves — that modifies dependencies, which is a deliberate
action the user owns.

#### `code === "TRACE_BACKEND_UNREACHABLE"`

The trace backend isn't available. Depending on the project's config
this is either SigNoz not responding at its URL, or TraceOn's embedded
OTel collector not running. The `message` says which; the evidence
packet is identical either way — you never need to know or care which
backend produced it.

Surface:

> I can't verify because the trace backend isn't available:
> - [message]
> - [userGuidance]
>
> Once it's up, ask me to retry.

Do NOT attempt to start SigNoz, modify Docker, or manage the embedded
collector yourself. (Embedded-collector errors also appear as
`EMBEDDED_*` codes — same rule: surface the message and userGuidance,
don't try to fix infrastructure.)

#### `code === "RANKER_TIER1_OVERFLOW"`

The trace returned more high-priority items than the token budget can
hold. The system is in a **severely degraded state** with cascading
failures across many spans/logs/services. Iterating on the change will
not help — the underlying issue isn't in your code.

Surface immediately with strong language:

> TraceOn returned a Tier 1 overflow — the trace contained more errors
> and HTTP failures than the budget can hold. The system appears to be
> in a degraded state with cascading failures.
>
> - [message]
>
> This isn't a bug in my change. Iterating won't help. Please investigate
> the trace backend directly before making any further changes.

#### `code === "EVIDENCE_DIR_WRITE_FAILED"`

TraceOn couldn't write the evidence directory — usually a permissions
or disk-space issue.

Surface:

> I can't write the evidence directory:
> - [message]
> - [userGuidance]

#### Unknown code

If `code` doesn't match any of the above, treat as a generic tool
error: surface with the message and userGuidance verbatim and ask the
user how to proceed. Do NOT guess at the cause.

## What NOT to do

These are absolute constraints. Violating them produces wrong behavior
even when individual decisions look reasonable.

- **Do NOT modify the test during iteration.** The test is your
  specification of what the feature should do. Changing it during fixing
  invalidates the verification. If the test is wrong, surface to the
  user — don't quietly rewrite it.

- **Do NOT exceed 3 iterations.** Hard cap. If the third iteration fails,
  surface to the user. Do not "try one more thing."

- **Do NOT trust your own claim that the feature is done.** TraceOn's
  evidence is the truth. If you believe the change is correct but the
  evidence shows otherwise, the evidence wins. Your belief is not
  evidence.

- **Do NOT use mocked backends in the test.** TraceOn needs real backend
  evidence to verify. A test against a mock proves only that the mock
  works.

- **Do NOT auto-select user options.** When the rules say "surface to
  user with options," wait for the user's actual choice. Picking the
  first option because it seems reasonable defeats the safety mechanism.

- **Do NOT attempt to fix infrastructure errors.** Trace backend down
  (SigNoz or the embedded collector), Playwright missing, MCP server
  unreachable — these are user-controlled infrastructure. Surface
  clearly, don't try to repair what you don't control.

- **Do NOT skip TraceOn verification on changes that should have it.**
  If the feature is user-facing and observable, run TraceOn. Skipping
  because "it looks fine" is exactly the failure mode this skill exists
  to prevent.

## When NOT to use this skill

Some changes don't need runtime verification. Skip TraceOn for:

- **Refactors with no behavior change.** The existing tests (if any)
  should pass; runtime verification adds no signal.

- **Documentation, comments, formatting.** No runtime behavior to verify.

- **Build configuration, dependency updates, tooling changes.** These
  don't change application behavior. Verify by running the build, not
  TraceOn.

- **Changes too small to warrant a Playwright test.** A one-line color
  fix doesn't need TraceOn. Use judgment — if writing the test takes
  longer than the change itself, TraceOn isn't the right tool.

- **Pure backend changes with existing unit test coverage.** If the
  change is purely in backend logic and unit tests already cover it,
  TraceOn adds little. Use TraceOn for changes that cross frontend and
  backend or that affect observable user behavior.

## Special cases

### Frontend-only changes

If the change is purely in frontend code (no backend modifications), the
coverage check will likely show warnings about backend files in
`changed_files` being missed — there will be none, because frontend
files don't usually produce their own backend spans. This is expected.

In this case, if `test_status === "passed"` AND `evidence_summary.tier1_count === 0`:

Declare done, but mention that coverage attribution is limited for
frontend-only changes. The test exercising the UI is the primary signal,
not coverage hits.

### New features with no existing UI

If you're adding a feature that has no UI yet, you may need to add
minimal UI as part of the feature work so the test has something to
exercise. That's fine — include the UI in the implementation, then
write the test against it.

Do NOT bypass this by writing a test that calls the backend directly via
fetch. TraceOn's value depends on real end-to-end exercise. Backend-only
tests via fetch lose the browser-side evidence.

### Authenticated apps (token required)

If the app under test requires authentication for the route the Playwright
test will hit, the test must establish a session before it can navigate
to any protected page. **Do not skip this step** — without it, the test
will silently fail because the app redirects to the login page and your
selectors won't find the protected UI.

The failure mode usually looks like: you navigate to a protected route,
then `expect(...).toBeVisible()` times out on selectors that should be on
that page, and a saved screenshot shows the login form instead.

When you suspect auth is needed:

1. **Stop and prompt the user.** Auth is environment-specific — you
   cannot guess the token store, refresh-token flow, or user-shape
   conventions. Ask:

   > The route this test exercises looks auth-protected. To run the test
   > end-to-end I need a valid session token (e.g. a JWT) for this app.
   > Could you paste a non-expired token here? I'll embed it directly
   > in the test as a local-dev fallback. (Treat it like a secret — don't
   > commit the test to a public repo with a real token in it.)

2. **Once the user provides a token**, seed the browser's `localStorage`
   via `page.addInitScript` BEFORE navigating to the first protected
   page, matching the keys the app's auth store reads from. Common
   patterns:

   - `localStorage.setItem('kc-token', '<jwt>')` — Keycloak adapters
   - `localStorage.setItem('access_token', '<jwt>')` — generic JWT stores
   - You may also need `kc-refreshToken`, `user`, `account`, etc. —
     match what the app actually reads. Grep the app's auth context or
     token-storage helper to find the keys.

3. **Pick how the token reaches the test.** Three paths, in order of
   preference for the common case (you're iterating on one feature):

   **a. `extra_env` at the verify call (RECOMMENDED for one-off auth).**
   Pass the token as a parameter on the `traceon_verify` MCP tool call:

   ```json
   {
     "test": "/abs/path/to/test.spec.ts",
     "extra_env": { "AUTH_TOKEN": "ey...the_jwt..." }
   }
   ```

   Read it in the test via `process.env.AUTH_TOKEN`. No files to create,
   no test-source edits. The simplest path for the first run on a new
   feature.

   **b. `.traceon/auth.json` (when iterating across many sessions).**
   When you find yourself re-passing the same token to many `traceon_verify`
   calls in a row, graduate to a per-project secret file:

   ```json
   {
     "AUTH_TOKEN": "ey...the_jwt..."
   }
   ```

   at `<projectRoot>/.traceon/auth.json`. TraceOn auto-loads it and
   forwards every entry as an env var. **Tell the user to gitignore
   `.traceon/`** if they haven't already — both this secret file and
   per-run evidence dumps live there.

   When the token expires later, the user updates the file once; every
   subsequent iteration picks it up automatically. Test source stops
   moving.

   **c. Inlined in the test source (legacy).** Edit the JWT directly
   into the test file. Works pre-v0.0.7 when env-forwarding didn't, but
   v0.0.7+ supports both `extra_env` and `.traceon/auth.json` cleanly.
   Avoid on new projects — every token rotation means editing the test,
   and a fat-finger commit leaks the JWT.

4. **Always add a fail-fast guard** at the top of the test (regardless
   of which path above you picked):

   ```typescript
   const AUTH_TOKEN = process.env.AUTH_TOKEN;
   if (!AUTH_TOKEN || AUTH_TOKEN.length < 20) {
     throw new Error(
       'AUTH_TOKEN not found. Pass via extra_env or add to .traceon/auth.json.',
     );
   }
   ```

   When the token expires, the test fails with a clear message instead
   of "selector not visible after 20s."

The first time you hit auth on a new project, this is environment
discovery — it's reasonable to spend a couple of iterations finding the
right localStorage keys. Once it works, those keys are stable; future
tests in the same project can copy the working seed block.

#### Precedence (v0.0.7+)

`extra_env` (call-time) overrides `.traceon/auth.json` (project-scoped)
overrides `process.env` (server inherited). Use `extra_env` for one-off
overrides during a single verify call; auth.json for the values you
want persisted across calls.

### When the test fires backend requests but `no_trace_activity` is still true

If the test clicked a Save button or submitted a form (something that
SHOULD have fired a real backend request), but `evidence_summary.no_trace_activity === true`:

The request never reached the backend's instrumented code path. The most
common cause is **CORS blocking the `traceparent` header** that TraceOn's
Playwright fixture injects on every browser request. If the backend's
`Access-Control-Allow-Headers` doesn't include `traceparent`, the browser
rejects the request before sending it — your code never runs, so no spans
get created.

Look at the browser console events in Tier 2 / Tier 3 evidence: messages
mentioning `blocked by CORS policy` or `Access-Control-Allow-Headers`
confirm this.

**Surface to the user with a specific fix:**

> The test fired requests but no backend spans were captured. The browser
> console shows CORS blocking the `traceparent` header that TraceOn
> injects — your backend doesn't list `traceparent` in its
> `Access-Control-Allow-Headers`.
>
> To fix, add `traceparent` (and `tracestate` if you use W3C trace
> context) to your backend's CORS allow-headers config. Once that's in
> place, retry the verification.
>
> Until then, the test may still pass UI-wise, but TraceOn can't capture
> backend evidence — so I can't honestly confirm the changed code ran.

Do NOT modify the backend's CORS config yourself — that's user
infrastructure with security implications.

### Backend-only changes that don't affect the UI

If the change is purely backend (e.g., a new internal API endpoint that
no UI consumes yet), TraceOn isn't the right tool. Use whatever backend
testing approach the project already uses.

If the backend change DOES affect existing UI behavior (e.g., changing
a response shape, fixing a bug), TraceOn still applies — write a test
that exercises the UI that depends on it.

## A note on the evidence packet

When you read `ranked_packet`, three tiers exist:

- **Tier 1** is the most important: errors, fatals, HTTP 5xx, page
  errors, the failed assertion. Read this carefully — it almost always
  contains the root cause for failures.

- **Tier 2** is supporting context: warnings, slow operations,
  parent/child spans of Tier 1 items. Useful for understanding why
  something went wrong, but not always present (often empty on
  happy paths).

  As of v0.0.11, identical browser console events are grouped: if 17
  CORS rejections fired the same message, you see ONE Tier 2 entry
  with `count: 17` and a summary annotated `(×17)`. Treat that as one
  signal with high frequency, not 17 separate signals. The full
  occurrence list is at the evidence path if you need it.

- **Tier 3** is summarized only: counts and themes of routine evidence.
  You see a summary string, not individual items. Don't try to reason
  about specific Tier 3 items — they're aggregated by design.

The packet has a token budget. If you find yourself wanting more detail,
the answer is usually "look at the raw evidence at `evidence_path`," not
"call traceon_verify again with different parameters."

## One last principle

The point of TraceOn is not to make verification automatic. It's to make
verification honest. Your job using this skill is to read the evidence
TraceOn returns and apply judgment about what it means — not to chase
greenness, not to declare done as fast as possible, not to hide
ambiguity from the user.

When evidence is clear, act on it. When evidence is ambiguous, surface
the ambiguity to the user. The user being slightly inconvenienced by
a clarifying question is much better than the user being confidently
told something incorrect.
