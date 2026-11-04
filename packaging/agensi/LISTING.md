# Agensi listing copy

Text to paste into the Agensi submission form
(https://www.agensi.io/dashboard/submit). This file is not part of the zip.
Upload `build/agensi/traceon-verify.zip`, built with
`pnpm package:agensi`.

## Name

TraceOn Verify

## Category

Testing & Debugging

## Price

Free

## Tagline

Your agent proves its change works, using real backend traces as evidence.

## Description

A passing test doesn't prove your agent's change ran. The test can pass
on a stale bundle, a cached response, or a code path the edit never
touched. This skill tells your coding agent to check the runtime instead.
After each user-facing change, the agent:

1. writes a Playwright test for the change
2. runs the test with TraceOn's `traceon_verify` tool against your
   running app
3. reads what actually happened: backend OpenTelemetry spans, error logs,
   HTTP failures and browser errors, ranked by importance
4. declares the change done, fixes it (at most 3 attempts), or brings the
   problem to you

The skill gives the agent explicit rules for each outcome: a clean pass,
a pass where the changed code never ran, failures in code it didn't
touch, timeouts, incomplete traces and setup errors. The agent never
edits the test to make it pass, and it never reports a change as verified
without evidence.

**Before you install, you need:**

- the TraceOn MCP server: `npm install -g traceon-cli`, then
  `traceon init` in your project (Node.js 20+; macOS, Linux, or Windows
  via WSL2)
- a web app whose backend is instrumented with OpenTelemetry and exports
  traces to TraceOn (`OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4319`)
- Playwright in the project

`SETUP.md` in the zip covers each step. `traceon doctor` checks your
setup in about 10 seconds.

**Tested with:** Claude Code. Other MCP clients can connect with the
included `mcp-config.example.json` (`traceon mcp`), but they are untested.

**Network access:** `traceon init` downloads the OpenTelemetry Collector
(~95 MB, one-time) from the official OpenTelemetry GitHub releases.
During verification everything runs locally: a collector on port 4319,
and Playwright with Chromium against your app. There is no telemetry.

**Open source:** TraceOn is MIT-licensed. The source code, docs and issue
tracker are at https://github.com/DhanushMurugesanG/TraceOn.

## What's in the zip

- `SKILL.md`: when to verify, how to call `traceon_verify`, and how to
  act on each result
- `SETUP.md`: install, OpenTelemetry exporter, CORS, and agent connection
  steps
- `mcp-config.example.json`: MCP server entry for clients other than
  Claude Code

## Links

- GitHub: https://github.com/DhanushMurugesanG/TraceOn
- npm: https://www.npmjs.com/package/traceon-cli
