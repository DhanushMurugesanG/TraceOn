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
- **If frontend and backend live on different origins**, the backend's CORS
  policy must include `traceparent` (and `tracestate` if you use W3C trace
  context) in `Access-Control-Allow-Headers`. Without that, the browser
  blocks every request TraceOn's Playwright fixture tries to inject the
  trace-propagation header into — the test will see no backend spans even
  though the UI looks fine. If you don't control the backend's CORS config,
  TraceOn's UI-level evidence still works; the backend trace correlation
  doesn't.
- **Auth-protected apps** need a one-time test-setup step to seed a session
  token before navigating to protected routes — see [docs/auth-and-cors-setup.md](docs/auth-and-cors-setup.md)
  for the workflow and copy-paste snippets.

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

## Troubleshooting

If `traceon_verify` returns confusing errors, empty evidence, or just doesn't seem to be picking your change up, run:

```bash
traceon doctor
```

It runs eight preflight checks in ~10 seconds and tells you what's wrong before you try to verify a change:

- **Playwright is installed** in this project
- **Playwright config is parseable** (extracts baseURL / webServer.url for the next checks)
- **Frontend reachable** at the baseURL
- **Backend reachable** at the detected backend URL (from vite proxy, `.env`, or common defaults)
- **CORS allows `traceparent`** — the biggest silent failure mode; without this, TraceOn sees zero backend spans even though tests "pass"
- **SigNoz reachable** at the configured URL
- **MCP server is registered** with Claude Code (`claude mcp list` includes `traceon`)
- **Skill is up to date** — your project's `.claude/skills/traceon-verify/SKILL.md` matches the bundled version (see "Upgrading" below)

Each failure includes a specific actionable fix — language-specific CORS snippets for gofiber, rs/cors, Node `cors`, and FastAPI; the exact npm command to install Playwright; etc.

Exit code is 0 when everything passes, 1 if any check failed. Safe to run repeatedly — the doctor is read-only and never modifies your config or files.

## Upgrading

`traceon-cli` upgrades via npm:

```bash
npm install -g traceon-cli@latest
```

That updates the global binary (so the MCP server picks up the new code on next Claude Code restart), but **does NOT update the agent skill file inside any project**. The skill lives at `<your-project>/.claude/skills/traceon-verify/SKILL.md` and was written by the last `traceon init` run. If the CLI ships new agent instructions (e.g. v0.0.7's `extra_env` support, v0.0.9's skill version stamp) and you don't re-run `traceon init`, the agent in that project still follows the older playbook.

After upgrading, re-run `traceon init` in each project that uses TraceOn:

```bash
cd your-project
traceon init    # overwrites .claude/skills/traceon-verify/SKILL.md with the new version
```

`init` is idempotent: it overwrites the skill, refreshes the MCP server registration in your Claude configs, and re-installs the Playwright fixture. It does NOT touch `.traceon/auth.json` or your test files.

As of v0.0.9, the MCP server compares its bundled skill version against the project's copy on the first `traceon_verify` call after startup and logs a single-line warning to stderr if they don't match. The warning names the exact remediation (`re-run traceon init`).

Then fully quit and reopen Claude Code (`Cmd+Q` on macOS — not just close window) so it reloads the MCP server.

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
