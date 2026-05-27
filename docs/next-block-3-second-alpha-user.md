# Next: Block 3 — find a second alpha user

**Hard commitment as of v0.0.11 ship.** No code work on TraceOn starts
again until at least one developer outside the maintainer has run it
against their own codebase and surfaced feedback.

This doc exists so the commitment doesn't slip in a future session
when "just one more dogfood iteration" feels tempting.

## Why this matters

Three rounds of feedback ([feedback-2026-05-26.md](feedback-2026-05-26.md),
[feedback-2026-05-26-round-2.md](feedback-2026-05-26-round-2.md),
[feedback-2026-05-27.md](feedback-2026-05-27.md)) and four releases
later (v0.0.4 through v0.0.11), all signal is from one user: the
maintainer dogfooding TraceOn on Trainery-Frontend + Review-cloud.

That's real signal, but it's biased N=1:

- The maintainer knows what TraceOn was designed to catch
- The maintainer's stack (Vite + Go gofiber + Keycloak + SigNoz) is
  one specific shape
- The maintainer is motivated to find wins
- The maintainer will forgive setup pain a random dev wouldn't

Another dogfood round risks **optimising TraceOn into a tool that's
perfect for the maintainer and untested for anyone else**. Each fix is
real but each fix is informed by the same blind spots.

## What "second alpha user" means

- A real developer (not an agent acting as a user)
- Running TraceOn against a codebase that is **not** Trainery-Frontend
  or Review-cloud
- Going through `traceon init` + writing one real feature + calling
  `traceon_verify`
- Sharing their unedited experience (wins AND friction)

It does not have to be a stranger. A teammate or friend qualifies, as
long as the stack is materially different from Trainery's.

## Where to look

Channels listed in priority order (the maintainer's call which to try
first):

1. **Personal network** — one or two specific developers who already
   use Claude Code. Highest signal-to-noise; lowest friction to ask.
2. **Anthropic Discord — MCP channel** — engaged audience, low ceremony.
3. **MCP-focused subreddits / X threads** — broader reach, slower
   signal.
4. **Hacker News Show HN** — only after the above produce ≥1 user.
   Premature HN posts produce noise feedback that doesn't compound.

## Convergent vs. divergent signal — the call

After the second user has used TraceOn:

- **If they hit the same pain points as the maintainer** (CORS,
  pnpm, env forwarding, timeouts) — that's **convergent signal**. The
  embedded-mode plan ([embedded-and-multi-backend-plan.md](embedded-and-multi-backend-plan.md))
  becomes justifiable. Ship v0.1.0.
- **If they hit different pain points** (their backend works fine,
  their auth flow is trivial, but X) — that's **divergent signal**.
  The architecture is broader than the maintainer's codebase. Address
  their specific friction in v0.0.12; defer embedded mode further.

Either outcome is valuable. The dangerous path is shipping v0.0.12+
without any external signal.

## What does NOT count as user #2

- The maintainer trying TraceOn on a different project they also own
- An agent running TraceOn as part of testing the maintainer's code
- A LLM-simulated user
- The maintainer writing feedback from a different perspective

The bar is: someone whose name is not on this repo, who runs TraceOn
on a project they care about for their own reasons, and who tells the
maintainer what they thought.

## How long to wait

The maintainer's own framing: "2-3 weeks." That's a soft ceiling. If
nobody bites in three weeks, the question shifts from "where do we
find a user" to "is the on-ramp too steep" — at which point landing
page polish or a "5-minute demo" recording would be the right work,
not more product features.

## Why this is written down

Without an explicit commitment, the path of least resistance is
another dogfood round next session. The maintainer correctly noted in
the round-3 feedback acceptance:

> If you do another dogfooding round and ship v0.0.12 based on it,
> you'll be optimizing TraceOn into a tool that's perfect for you
> specifically and untested for anyone else.

This doc is the artifact the next session should read before any
v0.0.12 code change starts. If the agent in that session is tempted
to ship another iteration, refer it here and ask "has a second user
run this yet?"
