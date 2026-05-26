# User feedback — 2026-05-26, round 2

Second-round feedback from the same user, after the v0.0.7 ship. Two
features verified in this session: `customApprovers` (success story) and
autosave (where TraceOn didn't help). Surfaced verbatim, plus a
maintainer's response with the next planned ship.

For context: round-1 feedback is at
[feedback-2026-05-26.md](feedback-2026-05-26.md), and the v0.0.7 ship
in response to it (extra_env + .traceon/auth.json + better timeout
diagnostics) is the commit immediately preceding this doc.

---

## Where it kept paying off

The `customApprovers` fix was a textbook win. One TraceOn run, 12 steps
green, 5 seconds. The implicit-evidence pattern — "the test asserts on
real DB-backed behavior, therefore the change is exercised" — kept the
coverage warnings from being noise. For a focused, short, cross-stack
assertion like that, TraceOn is the right tool. No question.

## Where it didn't help this round

The autosave step was a different story. TraceOn returned
`test_status: timedOut`, `duration_ms: 181542`,
`failure_message: "Test timeout of 180000ms exceeded"`. Tier 1 was a
single generic "Test timedOut" assertion summary. Tier 2 was 50+ CORS
errors against `:8000` Core API — every one of them was the same noise
from every previous run and unrelated to my change. None of that pointed
me at the actual problem.

I only found the real failure by running
`./node_modules/.bin/playwright test` directly and reading stderr:

```
locator.fill: Target page, context or browser has been closed
  at <fill line>
```

— meaning the test timeout fired during the fill. From there I added
`console.log` timing markers and learned steps 1-12 took 13.8 s but
step 13 hung for 166 s. That diagnosis sequence used **0 TraceOn signal**.

## The env-forwarding bug bit me again

Burned another iteration to `Error: AUTH_TOKEN env var is required to
run this test` before I remembered the workaround. Inline-token-then-strip
is grimy and every feature retests it.

## Updated take on ROI

**Bimodal.** Short, focused, cross-stack tests where the symptom hides
the cause (CORS, silent network drops, preflight, federation load) —
TraceOn earns its keep dramatically. Long compound tests with
timing/race failures — TraceOn returns a generic timeout and the actual
debugging happens in `playwright test` stderr.

## If I had budget for one TraceOn improvement

**Better timeout failure surfacing.** When `test_status === "timedOut"`,
the evidence packet should include **the last action the test was
attempting and the last DOM state**, not just "exceeded 180s." That
single change would have saved me ~15 minutes today.

---

## Maintainer's response

### Diagnosis: env-forwarding "bit me again"

This is **not a regression in v0.0.7** — the new mechanism works. What
almost certainly happened: the SKILL.md in `.claude/skills/traceon-verify/`
of your project is the pre-v0.0.7 version (written by an old
`traceon init`). The agent followed its old instructions ("inline a JWT
in the test, fail-fast guard, etc.") instead of using `extra_env` or
`.traceon/auth.json`.

The MCP server upgrades with `npm install -g traceon-cli@latest`. The
project-scoped skill file does not. To pick up the new instructions, the
user needs to re-run `traceon init` in each project that uses TraceOn.

**Action items:**

1. **Document the upgrade workflow** in the README (must run
   `traceon init` after CLI upgrades for skill-file refresh).
2. **Make skill file version-aware** later — bake a version stamp into
   the SKILL.md and warn from the MCP server when the loaded skill is
   older than the server. Deferred to a separate ship.

### Plan: better timeout failure surfacing (next ship)

The user's recommendation is the right one. Concrete plan for v0.0.8:

Playwright's JSON report DOES contain per-step data even on timeout.
Each step has `title`, `duration`, optional `error`, and a `location`
(file:line:col). The step that was running when the timeout fired is
the last one in the array with no completion marker; its `error.message`
usually contains the precise failure ("locator.fill: Target page, context
or browser has been closed").

Currently `buildSummaryFromReport` collapses the entire steps array
into `steps_executed: string[]` — titles only, no errors, no locations.
On a passing run that's correct. On a timeout it's lossy.

**Changes for v0.0.8:**

| Step | Change | Test |
|---|---|---|
| 1 | Extract `extractTimeoutContext(result)` → `{ lastStep, location, lastStepError, attachments }` from PWResult when status is timedOut. | yes |
| 2 | When result.status === 'timedOut', `buildSummaryFromReport` formats failure_message with: leading sentence naming the step that timed out + its location + its error message + any screenshot/trace attachment paths. Fall back to the generic "Test timeout of … exceeded" only when no per-step info is available. | yes |
| 3 | Update SKILL.md "When the test timed out without errors" decision rule to use the new specifics. Tell the agent to read `lastStep` first, not just `test_status`. | — |
| 4 | (Optional) Surface a one-line hint when the project has no `screenshot: 'only-on-failure'` in playwright.config.ts so users know to enable it for richer timeout diagnostics. Skip if too invasive for now. | — |

**Not in scope for v0.0.8:**

- Capturing live DOM state at timeout. Playwright can do this via
  `screenshot: 'on'` or `trace: 'on-first-retry'` in the project's
  config — we can recommend it but can't override it from TraceOn.
- Deprioritising the "50+ background CORS errors" Tier 2 noise. That's
  a ranker improvement — separate, larger piece of work.

ETA: ~30-40 min. Ship as `traceon-cli@0.0.8` once the user signs off
on the plan.

### Backlog after v0.0.8

| # | Item | Notes |
|---|---|---|
| 1 | Skill-staleness detection / version stamp | Saves users from running `traceon init` after every upgrade |
| 2 | Preflight environment check (`traceon doctor`) | From round-1 feedback, drag #2 |
| 3 | Ranker improvement: deprioritise background errors | Address the "50+ same CORS errors as Tier 2 noise" complaint |
| 4 | Coverage warning denoising | From round-1 feedback, drag #3 |
