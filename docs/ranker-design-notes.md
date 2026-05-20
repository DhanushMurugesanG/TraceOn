# Ranker design notes

## The Tier 1 overflow threshold (80%)

The ranker throws `RankerTier1OverflowError` if Tier 1 evidence exceeds 80% of the total budget (40,000 tokens by default when `budget_total: 50_000`).

### Why throw instead of truncate

If Tier 1 alone takes 80%+ of the budget, something is catastrophically wrong with the run — retry storms, cascade failures across many services, instrumentation bugs producing duplicate errors. In these cases, compact summarization isn't useful. The agent can't reason about 40,000 tokens of errors and produce a meaningful action.

Silently truncating Tier 1 would let the agent declare "fixed" against incomplete error evidence, which breaks the product's core promise. Failing loudly with an error code and pointing to raw evidence on disk is the safer behavior.

The three options considered:

- **Option A (chosen): throw on overflow.** Fail loudly. Caller surfaces error to user, points them to raw evidence on disk.
- **Option B (rejected): truncate Tier 1 to fit.** Silently drops critical errors. Agent declares "fixed" against incomplete evidence. Breaks the product's promise in exactly the cases it matters most.
- **Option C (rejected): expand budget to fit.** Defers the problem to the LLM's actual context window, which has the same overflow issue at a different layer.

### Real-world Tier 1 sizes

In normal operation:

| Scenario | Tier 1 size | % of 50k budget |
|---|---|---|
| Typical failed test | ~1,150 tokens | 3% |
| Multi-service cascade failure | ~3,000 tokens | 7.5% |
| Genuinely broken environment | ~12,000 tokens | 30% |

Hitting the 80% threshold requires pathological scenarios like 100+ retry failures, hundreds of ERROR spans from a stuck service, or instrumentation bugs producing duplicate spans. These are "your test infrastructure is broken" situations, not normal verification failures.

### Budget vs LLM context window

50,000 tokens is TraceOn's *internal* budget, NOT the LLM's context limit. Claude has 200k tokens of context available. TraceOn deliberately uses much less because:

1. Evidence shares space with system prompt, codebase context, conversation history
2. Smaller packets produce better LLM reasoning (the "lost in the middle" effect)
3. The ranker's job is cognitive filtering before the LLM has to do it

A 5,000-token packet with the right evidence outperforms a 50,000-token dump that includes the right evidence buried in noise.

### Tuning plan for v1.1

Ship v1 with `budget_total: 50_000` and the 80% threshold unchanged. In M8 alpha, log actual `budget_used` for each run.

After 50-100 real verifications, decide based on:

- **Median budget use** — should be 1-10%
- **95th percentile** — should be under 30%
- **Overflow frequency** — should be under 1%

If real data shows overflow happens more than once per month of normal use, increase `budget_total` to 100,000 in v1.1. Otherwise leave the default alone.

Resist the urge to tune preemptively. Ship the default, measure, then adjust.

## Tier 2's opposite philosophy

Worth noting that Tier 2 uses the opposite approach from Tier 1: greedy-pack into whatever budget remains, drop items that don't fit. This is correct because Tier 2 is "useful context if there's room," not "critical evidence." Dropping Tier 2 items doesn't break correctness; dropping Tier 1 items does.

The `omittedCount` in the return value tells the caller how many Tier 2 candidates were dropped. This is informational — agents don't need to act on it.

## The ranker is a pure function

This is invariant I2 from the PRD. The ranker has zero side effects: no `console.log`, no `fs`, no `fetch`, no `process.env`, no `Date.now()`. This is non-negotiable because:

1. **Testability.** Pure functions are trivially testable with fixtures.
2. **Determinism.** Same input always produces same output, which makes regression testing meaningful.
3. **Composability.** The ranker can be called from CLI, MCP server, future test harnesses, etc., without environment coupling.

If you ever find yourself wanting to add I/O to the ranker, stop and reconsider. The right place for I/O is in the gather phase (Section 12), which produces the ranker's input. Don't muddle the layers.
