# TraceOn

Runtime verification for AI coding agents. TraceOn is an MCP server that lets Claude Code verify code changes actually work end-to-end — not just that they compile.

## What it does

After Claude Code edits your code, it calls TraceOn with a Playwright test it wrote. TraceOn runs the test, captures distributed traces from your services via OpenTelemetry, ranks the evidence by importance, and returns a structured `VerificationResult`. Claude then reasons over that evidence to decide done / iterate / surface to you.

The point isn't to make verification automatic. It's to make verification honest: real runtime evidence in the agent's loop, not just what Claude claims happened.

As of v0.2.0, TraceOn ships **embedded mode**: it downloads and runs its own OTel Collector on first `traceon init`. No Docker, no SigNoz install, no API key — your backend exports OTLP straight to TraceOn's local port. Users who already run SigNoz can keep using it (see "Bring your own backend").

## Status

Alpha. v0.2.0 ships with:

- **Embedded backend (default)** — TraceOn runs its own OTel Collector; zero extra services
- SigNoz backend for existing installs (fully backward compatible)
- Mac and Linux only (Windows planned for v1.2; runs today on Windows via WSL2 — see [docs/wsl-setup.md](docs/wsl-setup.md))
- A sample app (sibling repo `traceon-spike`) for testing

See [CHANGELOG.md](CHANGELOG.md) for release notes.

## Prerequisites

- Node.js 22+ (Node 20+ works; the CLI's `engines` floor is 20)
- **On Windows?** Run everything under WSL2 Ubuntu — see [docs/wsl-setup.md](docs/wsl-setup.md) (keep the project in `~/...`, and install the Playwright browser system deps)
- pnpm 11+
- Claude Code (with MCP server support)
- A web app with a frontend that talks to an OTel-instrumented backend
- For the SigNoz backend only: Docker, a running SigNoz, and an API key
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

### 1. Install TraceOn

```bash
npm install -g traceon-cli
```

During the v0.2.0 shakeout, v0.2.0 is published under the npm `next` tag (`latest` is still 0.0.11), so install it with `@next`:

```bash
npm install -g traceon-cli@next
```

Once v0.2.0 is promoted to `latest`, the plain `npm install -g traceon-cli` above will pull it.

### 2. Initialize in your project

```bash
cd your-project
traceon init
```

Pick **Embedded** at the backend prompt (the default). `init` downloads TraceOn's OTel Collector (~95 MB, one-time, checksum-verified into `~/.traceon/bin/`), writes `.traceon/config.json` into your project, registers the MCP server with Claude Code, and installs the `traceon-verify` skill into `your-project/.claude/skills/`.

### 3. Point your backend's OTel exporter at TraceOn

The one manual step. In your backend's OTel SDK bootstrap (or environment):

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4319
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

If you already export traces to an observability stack, keep that exporter and add TraceOn as a second target (OTel SDKs support multiple span processors natively) — see [docs/embedded-mode-setup.md](docs/embedded-mode-setup.md) for per-language snippets.

### 4. Restart Claude Code

**Fully quit Claude Code** (Cmd+Q on macOS — not just close window) and reopen it. The `traceon_verify` tool should now appear in Claude's tool list.

### 5. Try it

In Claude Code, ask for a small user-facing change in your project — for example:

> Add a character counter under the textarea on the home page. Make sure it works.

Claude should write the implementation, write a Playwright test, call `traceon_verify`, read the evidence, and report what was verified. If anything fails, Claude iterates — up to 3 times — based on the Tier 1 evidence.

## Bring your own backend (SigNoz)

If you already run SigNoz, pick **SigNoz** at the `traceon init` backend prompt. You'll need SigNoz running (the [Docker install guide](https://signoz.io/docs/install/docker/)) and an API key (**Settings → API Keys**). Existing pre-v0.2.0 installs keep working without any changes — env-var-configured SigNoz setups are detected automatically when no `.traceon/config.json` names a backend.

With SigNoz you also get its UI for ad-hoc trace exploration; embedded mode stores traces per-run with no UI. That's the trade.

## Troubleshooting

If `traceon_verify` returns confusing errors, empty evidence, or just doesn't seem to be picking your change up, run:

```bash
traceon doctor
```

It runs nine preflight checks in ~10 seconds and tells you what's wrong before you try to verify a change:

- **Playwright is installed** in this project
- **Chromium actually launches** — catches WSL2 / minimal-Linux setups where the browser can't start because system libraries (libnss3, …) are missing; fix points to `sudo npx playwright install-deps`
- **Playwright config is parseable** (extracts baseURL / webServer.url for the next checks)
- **Frontend reachable** at the baseURL
- **Backend reachable** at the detected backend URL (from vite proxy, `.env`, or common defaults)
- **CORS allows `traceparent`** — the biggest silent failure mode; without this, TraceOn sees zero backend spans even though tests "pass"
- **Backend available** — embedded: the collector binary is installed; SigNoz: the configured URL responds
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

Backend selection lives in `<your-project>/.traceon/config.json`, written by `traceon init`:

```jsonc
{
  "backend": "embedded",          // or "signoz"
  "embedded": {
    "port": 4319,                 // OTLP/HTTP receiver port
    "settle": {                   // optional trace-settle tuning
      "maxWaitMs": 60000,         // hard ceiling on the wait
      "stabilityMs": 10000,       // "settled" = span count unchanged this long
      "pollMs": 2000              // how often to re-check
    }
  }
}
```

When no config file names a backend, the MCP server derives a SigNoz config from env vars — exactly the pre-v0.2.0 behavior:

| Variable | Default | Purpose |
|---|---|---|
| `SIGNOZ_API_KEY` | — | Sent as `SIGNOZ-API-KEY` header to SigNoz. |
| `SIGNOZ_BASE_URL` | `http://localhost:8080` | SigNoz UI / API base URL. |
| `TRACEON_EVIDENCE_ROOT` | `.traceon/runs` | Where to write per-run evidence directories. |

Run history is persisted to `~/.traceon/runs.db` (SQLite). Per-run evidence (raw spans, logs, browser events) lands under `${TRACEON_EVIDENCE_ROOT}/<run_id>/`. Embedded-mode trace files live in `~/.traceon/embedded/` and are cleared at the start of each MCP server session.

## Limits

- **Two backends: embedded (default) and SigNoz.** Tempo / Jaeger / Datadog / Honeycomb are planned on the same `EvidenceBackend` interface (v0.3.0+).
- **Embedded mode captures backend logs only if your OTel SDK exports them.** Most trace-only SDK setups produce spans but no OTLP logs; trace evidence is unaffected.
- **Mac and Linux only.** Windows support is planned for v1.2. On Windows, run TraceOn under WSL2 Ubuntu today — see [docs/wsl-setup.md](docs/wsl-setup.md) for the setup gotchas.
- **File-level coverage attribution is OpenTelemetry-limited.** Backend spans are attributed by OTel to the route/framework, not the specific source file that ran. TraceOn surfaces this as `coverage.attribution_limited: true` rather than a false alarm; the skill knows to downgrade the warning when the test asserted on a real response body.
- **FastAPI / ASGI backends don't set `code.filepath`.** Python OTel auto-instrumentation omits `code.*` span attributes by default, so changed FastAPI/ASGI source files land in `coverage.misses` with `coverage.attribution_limited: true` even though they ran. The spans still arrive and rank normally — treat these misses as low-confidence and verify by asserting on the response body in your Playwright test. See [docs/embedded-mode-setup.md](docs/embedded-mode-setup.md#python--fastapi-codefilepath-attribution).
- **The trace-settle wait defaults to 60s max.** TraceOn skips the wait entirely for tests that fire no responses (returns in ~2s). Embedded mode exposes the settle timings via `.traceon/config.json`; the SigNoz wait isn't currently tunable per call.
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

[MIT](LICENSE) © Dhanush Murugesan

## Contributing

Contributions are welcome! See [CONTRIBUTING.md](CONTRIBUTING.md) to get set up,
and please review our [Code of Conduct](CODE_OF_CONDUCT.md). For security
issues, follow the [Security Policy](SECURITY.md) rather than opening a public
issue.
