# A user's first-run experience

A real, unedited postmortem from the first session using TraceOn against a
production-shaped app (Trainery-Frontend + Review-cloud Go backend), after
setting it up via `traceon init`. Surfaced verbatim because it captures
both the friction we still have to smooth and the one moment TraceOn paid
for the rest of the setup pain in a way no other tool would have.

Context: the task was a "save as draft" cycle wizard feature crossing
Go backend + React frontend. Three rounds of `traceon_verify`, three
different failure modes.

---

> **Round 1:** TraceOn's runner shells out to `pnpm exec`, your repo's
> `pnpm install` errored on `ERR_PNPM_IGNORED_BUILDS: esbuild@0.27.7`, so
> the wrapper bailed in 16 seconds before Playwright ever loaded. Zero
> spans, zero evidence. I worked around it by running
> `./node_modules/.bin/playwright` directly — useful for proving the test
> logic worked, but lost the trace evidence TraceOn exists to give.
>
> **Round 2 (the long auth detour):** Running Playwright direct surfaced
> real failures that had nothing to do with TraceOn: I'd hardcoded
> `BASE_URL=5173` (which turned out to be some unrelated "TraceOn spike"
> demo on your machine — funny). After fixing to 3004 the shell-app was
> hung, then came back. Then the test hit Login because seeding
> `localStorage.access_token` wasn't enough — shell-app has TWO auth
> contexts, and the one that gates routes uses `access_token` + `user` +
> `account` keys. After seeding all three from the JWT claims, the test
> passed in 2.5s and three real drafts showed up in the DB via curl. So
> the feature was verified, but only through a side channel.
>
> **Round 3 (the payoff):** You said the TraceOn package got updates. The
> pnpm block was gone. Token env wasn't forwarded so I inlined it. Test
> ran 6 steps then died waiting for the success toast. Direct Playwright
> would have left me guessing — "is the toast slow? is the click flaky?"
> — but TraceOn's Tier 2 packet immediately named the cause: every API
> request died on CORS preflight because the TraceOn fixture adds a
> `traceparent` header and your `AllowHeaders` list didn't include it.
> That was the single most valuable moment of using TraceOn in this whole
> task — I never would have found that from a screenshot or a Playwright
> stack trace. One-line CORS fix on `main.go:255`, all 9 steps green.
>
> **Net take:** TraceOn earned its keep on round 3 specifically because
> the failure mode (`traceparent` blocked at preflight) was invisible to
> standard test tooling. Rounds 1 and 2 burned more time than they should
> have on infrastructure shape — pnpm config, env forwarding,
> two-auth-contexts plumbing — that aren't TraceOn's fault but make
> first-run friction high if you haven't onboarded the harness before.
> Worth it once you're past that.

---

## What we did about each round

The friction in rounds 1 and 2 is now addressed in releases that shipped
after this session:

| Round | Friction | Where it's fixed |
|---|---|---|
| 1 | Hardcoded `pnpm exec`, broke on `ERR_PNPM_IGNORED_BUILDS` | [`traceon-cli@0.0.5`](https://www.npmjs.com/package/traceon-cli) — MCP server now resolves `<projectRoot>/node_modules/.bin/playwright` directly, only falls back to `npx --no-install`. No package manager in the call chain. |
| 1 | `JSON.parse(stdout)` choked on pnpm warnings | `traceon-cli@0.0.5` — JSON report is now written to a file inside `evidenceDir` via `PLAYWRIGHT_JSON_OUTPUT_NAME`. stdout noise no longer matters. |
| 1 | "Failed to parse Playwright report" hid the real cause | `traceon-cli@0.0.5` — failure message now includes the actual parse error, exit code, evidence dir path, and last 500 chars of both stdout and stderr. |
| 2 | Multi-auth-context seeding wasn't documented | [`traceon-cli@0.0.6`](https://www.npmjs.com/package/traceon-cli) — the agent skill now has an "Authenticated apps" section telling Claude to stop, ask for a JWT, inline it, and seed the common localStorage keys. See [auth-and-cors-setup.md](auth-and-cors-setup.md). |
| 3 | CORS for `traceparent` wasn't documented (but the evidence was instantly readable) | `traceon-cli@0.0.6` — README prerequisite + agent decision rule. The evidence path was already there; this just makes Claude surface it as a specific fix. |

## Why this story is in the docs

Two reasons.

**Calibration.** New users should know upfront that the first run on a
production-shaped app is friction-heavy. The sample-app onboarding looks
easy because the sample app is unauthenticated and same-origin; almost no
real app is. If you're hitting setup pain on a real codebase, that's
expected, and the docs here exist to short-circuit it.

**The Tier-2 win is the actual product.** Many tools can run a Playwright
test. Only TraceOn correlates the browser-side run with backend traces
and surfaces the precise cause of an "everything looks like it should
work, but no backend evidence" failure — which in this case was a
preflight CORS rejection that a screenshot, a Playwright stack trace, and
even DevTools network tab would all miss without specifically looking
for it. That moment is what we're optimising the rest of the experience
around.

## Related setup docs

- [auth-and-cors-setup.md](auth-and-cors-setup.md) — the two
  setup gotchas this story hit, with copy-paste fixes.
