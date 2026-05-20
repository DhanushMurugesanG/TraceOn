# Architecture decisions

## The agent is the LLM (no LLM inside TraceOn)

### What we decided

TraceOn does NOT call an LLM internally. It produces structured runtime evidence and returns it to whoever called `traceon_verify`. The caller (Claude Code, in v1) is the LLM that reasons over the evidence.

### What we rejected

Earlier PRD drafts had TraceOn calling Claude internally to generate a "verdict" — a structured root-cause analysis attached to the verification result. We cut this for v1.

### Why we cut it

Three reasons:

**1. Redundant work.** Claude Code is already the LLM in the loop. Asking TraceOn to call Claude again to generate a verdict means two LLM calls per verification, both producing roughly the same reasoning. Wasteful in tokens and latency.

**2. Architectural complexity.** A verdict-generating TraceOn needs API keys, prompt templates, retries, fallbacks, model selection logic, and cost controls. None of that adds product value over "let the caller's LLM reason."

**3. Caller flexibility.** Without an internal LLM, TraceOn works with any agent — Claude Code today, Cursor tomorrow, custom agents whenever. The verdict-generation flavor would tightly couple TraceOn to one model provider.

### When this might change

If TraceOn ever ships a standalone CLI mode (no agent in the loop), it would need to produce its own verdicts for the developer to read directly. That's a real v1.1+ feature. The architecture supports adding it later — just bolt a verdict-generation layer on top of the ranker's output.

For v1, the agent is the LLM. TraceOn is upstream of the LLM, not on the same layer.

---

## The Option 3 workflow choice (and why we simplified it)

### The four options we considered

Early in the design, we worked through four possible workflows for how the agent should interact with TraceOn when implementing a new feature:

**Option 1: Pre-existing tests only.** TraceOn requires a Playwright test to already exist in the project before it can verify. This works for regression-style bug fixes but breaks down for new features (no test exists yet because the feature is new).

**Option 2: TraceOn generates the test from intent.** The agent calls `traceon_verify` with just an intent string; TraceOn generates a Playwright test by reading the user's intent plus the implementation files. Convenient but has a fundamental integrity hole: the test generator sees the implementation, so the test will mirror the implementation's bugs.

**Option 3: Agent writes test before implementation (TDD discipline).** The agent writes a Playwright test from intent *before* writing any implementation. Validates the test fails (because no implementation exists yet). Then writes implementation. Then verifies. Cryptographically anchored via authoring tokens.

**Option 4: Stage-gated workflow.** TraceOn enforces phases (plan → test → implement → verify) with hard locks between phases. Closest to formal TDD.

### What we chose

**A simplified version of Option 3.** The agent writes implementation and test together, then calls `traceon_verify`. No authoring tokens, no separate validation phase, no cryptographic anchoring.

### Why we simplified Option 3

The full Option 3 with authoring tokens added significant complexity:
- A separate MCP tool `traceon_validate_test_authoring`
- HMAC-signed tokens
- A `test_authorings` SQLite table
- A two-phase commit dance

This complexity was defending against an *adversarial* agent that might cheat the verification. For v1, the realistic threat model is an *honest* agent that's trying to do its job. Defending against adversarial misuse adds friction without solving real v1 problems.

The simplified version trusts the agent in good faith:
- Single MCP tool: `traceon_verify`
- The agent writes test + implementation together
- The coverage check (built into the ranker) catches the most common failure mode: "test passed but didn't actually exercise the changed code"

### The trade-off we accepted

An honest mistake by the agent could produce a test that mirrors the implementation's bugs. The test passes, TraceOn reports success, and the bug ships.

The defenses against this are:
1. **Coverage check.** If the test passes but the changed file had no spans, TraceOn warns.
2. **Intent hint.** TraceOn scans evidence for intent-related keywords and surfaces concerns.
3. **Human code review.** The developer reads what the agent wrote before merging.

These aren't bulletproof. A genuinely adversarial agent could defeat them. But for v1, "honest agent + multiple defensive layers" is the right altitude.

### When this might change

If real usage shows agents producing implementations-mirror-bugs tests, v2 could add:
- Optional TDD-discipline mode (write test first, validate it fails, then implement)
- Test-quality heuristics (does the test have multiple assertions? cover failure paths?)
- Mutation testing integration to grade test adequacy

These are real v2 features. None of them block v1 shipping.

---

## The competitive position vs Claude Code's `/goal`

Anthropic shipped `/goal` in Claude Code v2.1.139 in May 2026, days after we locked in TraceOn's design. The feature has visible architectural overlap with TraceOn.

### What `/goal` does

`/goal` is a **loop runner** with a separated evaluator model. The user sets a completion condition; Claude keeps iterating; a smaller evaluator model (Haiku) reads the conversation transcript and decides whether the condition is met.

### What `/goal` cannot do

The evaluator reads transcripts only. It can't:
- See actual runtime evidence (traces, logs, spans)
- Detect "test passed but didn't exercise the change" silent failures
- Attribute failures across services
- Verify backend behavior that didn't get reported in the chat

If Claude claims tests passed without actually running them, the `/goal` evaluator has no way to verify.

### Where TraceOn is structurally different

TraceOn is an **evidence provider**, not a loop runner. It captures real runtime evidence — what actually happened across services during a test — and returns it to the agent.

The two can be used together: `/goal` keeps the loop going, TraceOn verifies each iteration.

### The honest positioning

Don't pitch TraceOn as "a better /goal." Pitch it as solving a different problem.

`/goal` answer: "is the condition met based on what Claude said it did?"
TraceOn answer: "what actually happened in the running system?"

Both are useful. They're complementary. The natural integration is: agent uses TraceOn to get evidence, agent reasons about evidence, `/goal` keeps Claude iterating until TraceOn's verification passes.

### The risk to watch

If Anthropic ships a future feature that adds runtime evidence ingestion to the `/goal` evaluator (e.g., "evaluator can read OpenTelemetry traces"), TraceOn's positioning gets squeezed. Worth tracking. The Anthropic + OpenAI pattern of shipping similar features within weeks of each other suggests both companies are watching the same problem space carefully.

For now, the gap is real and worth building toward.
