# docs

Design notes, architecture writeups, and reference material for TraceOn.

## Setup guides

- [auth-and-cors-setup.md](auth-and-cors-setup.md) — two common gotchas
  when pointing TraceOn at a real-world app: auth-protected backends
  (token handling) and `traceparent` CORS allow-headers.
- [first-run-experience.md](first-run-experience.md) — an unedited
  user postmortem from a first run on a production-shaped app: the
  friction we've since fixed, and the moment TraceOn pays for itself.
- [feedback-2026-05-26.md](feedback-2026-05-26.md) — second-session
  feedback with a prioritised fix backlog. The "highest-ROI ask" thread.
- [feedback-2026-05-26-round-2.md](feedback-2026-05-26-round-2.md) —
  post-v0.0.7 feedback: bimodal ROI take, env-forwarding "bit me
  again" (skill staleness diagnosis), and the next ship plan (timeout
  failure surfacing).
- [feedback-2026-05-27.md](feedback-2026-05-27.md) — round-3, post-
  v0.0.10. Four new failure modes (dev-server staleness, Tier 2 noise,
  coverage warning false positives, state-drift). Includes the v0.0.11
  fix bundle proposal.

## Design / architecture

- [architecture-decisions.md](architecture-decisions.md)
- [observability-stack-decisions.md](observability-stack-decisions.md)
- [ranker-design-notes.md](ranker-design-notes.md)

## Roadmap plans

- [embedded-and-multi-backend-plan.md](embedded-and-multi-backend-plan.md) —
  the four-phase plan to ship embedded mode (no SigNoz required) and
  multi-backend support (Tempo, Jaeger, Datadog, Honeycomb). Targets the
  recurring "setup friction is brutal" feedback. Includes the
  "alternative triggers" matrix.
