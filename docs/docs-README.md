# Design notes

This folder contains "why we chose this" notes for non-obvious design decisions in TraceOn. The intent is to preserve reasoning that would otherwise be lost between sessions.

## When to add a note here

Add a new doc whenever:
- We make a non-obvious technical decision (e.g., why this algorithm, why this library)
- We choose between competing approaches (e.g., A vs B vs C, picked A because...)
- We cut a feature from v1 for a specific reason (e.g., the v1.1-ideas list)
- We discover something during the build that future-us will need to know (e.g., "OTel auto-instrumentation handles this case correctly, don't worry about it")

The threshold is "if I lost this context, would the next session waste an hour re-debating it?" If yes, write it down.

## When NOT to add a note here

Don't write notes for:
- Code that explains itself (a function with a clear name doesn't need a doc)
- Personal preferences (use comments in code instead)
- Things in the PRD already
- Speculative future plans (those go in `v1.1-ideas.md`, not design notes)

## Index

| File | What it covers |
|---|---|
| `ranker-design-notes.md` | The Tier 1 overflow threshold, tier philosophy, pure-function discipline |
| `architecture-decisions.md` | Agent-is-the-LLM, Option 3 simplified, competitive vs `/goal` |
| `observability-stack-decisions.md` | Why SigNoz, why W3C `traceparent`, why Node + TypeScript |

## Reading order for someone new

If you're a future agent or collaborator picking up TraceOn for the first time, read in this order:

1. `../prd.md` — the full product spec
2. `architecture-decisions.md` — the high-level "why"
3. `observability-stack-decisions.md` — the foundation choices
4. `ranker-design-notes.md` — the moat of the product

After those four, you'll have the design context needed to make changes without re-litigating decisions.
