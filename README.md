# TraceOn

Runtime verification for AI coding agents. TraceOn is an MCP server that lets Claude Code verify code changes actually work end-to-end — not just that they compile.

## What it does

After Claude Code edits your code, it calls TraceOn with a Playwright test it wrote. TraceOn runs the test, captures distributed traces from your services via OpenTelemetry + SigNoz, ranks the evidence by importance, and returns a structured `VerificationResult`. Claude then reasons over that evidence to decide done / iterate / surface to you.

The point isn't to make verification automatic. It's to make verification honest: real runtime evidence in the agent's loop, not just what Claude claims happened.

## Status

Alpha. v1 ships with:

- A single backend connector (SigNoz)
- Mac and Linux only (Windows planned for v1.2)
- Manual MCP setup (`traceon init` automation planned for v1.1)
- A sample app (sibling repo `traceon-spike`) for testing

## Prerequisites

- Node.js 22+
- pnpm 11+
- Docker (for SigNoz)
- Claude Code (with MCP server support)
- A SigNoz API key (generate at `localhost:8080` → Settings → API Keys)
- A web app with a frontend that talks to an OTel-instrumented backend

## Quick start

### 1. Start SigNoz

Follow the [SigNoz Docker install guide](https://signoz.io/docs/install/docker/). Verify it's running at `http://localhost:8080`. Sign up locally and generate an API key under **Settings → API Keys**.

### 2. Install TraceOn

```bash
npm install -g traceon-cli
```

### 3. Initialize in your project

```bash
cd your-project
traceon init
```

`init` prompts for your SigNoz API key and base URL, registers the MCP server in Claude Code's `claude_desktop_config.json`, and installs the `traceon-verify` skill into `your-project/.claude/skills/`.

### 4. Restart Claude Code

**Fully quit Claude Code** (Cmd+Q on macOS — not just close window) and reopen it. The `traceon_verify` tool should now appear in Claude's tool list.

### 5. Try it

In Claude Code, ask for a small user-facing change in your project — for example:

> Add a character counter under the textarea on the home page. Make sure it works.

Claude should write the implementation, write a Playwright test, call `traceon_verify`, read the evidence, and report what was verified. If anything fails, Claude iterates — up to 3 times — based on the Tier 1 evidence.

## How it differs from `/goal`

`/goal` keeps Claude iterating until an evaluator agrees a condition is met. The evaluator reads the conversation transcript only.

TraceOn captures real runtime evidence — actual HTTP requests, real backend spans, real failed assertions. The two are complementary: use `/goal` to keep the loop going, use TraceOn to make sure the loop is checking the right thing.

## Configuration

Environment variables read by the MCP server:

| Variable | Default | Purpose |
|---|---|---|
| `SIGNOZ_API_KEY` | — | Required. Sent as `SIGNOZ-API-KEY` header to SigNoz. |
| `SIGNOZ_BASE_URL` | `http://localhost:8080` | SigNoz UI / API base URL. |
| `TRACEON_EVIDENCE_ROOT` | `.traceon/runs` | Where to write per-run evidence directories. |

Run history is persisted to `~/.traceon/runs.db` (SQLite). Per-run evidence (raw spans, logs, browser events) lands under `${TRACEON_EVIDENCE_ROOT}/<run_id>/`.

## Limits

- **SigNoz only.** Other observability backends (Tempo, Honeycomb, Datadog) aren't supported. The connector layer is designed to allow more; only SigNoz ships in v1.
- **Mac and Linux only.** Windows support is planned for v1.2.
- **File-level coverage attribution is OpenTelemetry-limited.** Backend spans are attributed by OTel to the route/framework, not the specific source file that ran. TraceOn surfaces this as `coverage.attribution_limited: true` rather than a false alarm; the skill knows to downgrade the warning when the test asserted on a real response body.
- **The SigNoz wait is fixed at 60s.** TraceOn skips the wait entirely for tests that fire no responses (returns in ~2s), but otherwise the wait isn't currently tunable per call.
- **No CI/CD integration.** v1 is for local dev / staging. Production environment safety is out of scope.
- **TraceOn doesn't generate verdicts.** The agent (Claude Code) reasons over the evidence. The MCP tool returns structured `VerificationResult`s only.
- **Iteration logic lives in the skill, not the tool.** TraceOn is stateless per call. Iteration discipline is enforced by `skills/traceon-verify/SKILL.md`.

## Development

```bash
pnpm -r build       # build all packages
pnpm -r typecheck   # typecheck all packages
pnpm -r test        # run all tests (vitest)
```

The `Makefile` at the repo root has convenience targets — run `make` with no args to list them.

## License

[TBD]
