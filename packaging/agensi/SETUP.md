# TraceOn setup

`SKILL.md` tells your agent when and how to verify changes with TraceOn.
The skill needs the TraceOn MCP server running on your machine, and the
server needs your app to emit OpenTelemetry traces. Setup takes about
10 minutes.

## What you need

- **Node.js 20+** on macOS or Linux. On Windows, use WSL2:
  https://github.com/DhanushMurugesanG/TraceOn/blob/main/docs/wsl-setup.md
- **A web app with a frontend and an OpenTelemetry-instrumented backend.**
  Any language with an OTel SDK works: Node.js, Python, Go, Java, .NET
  and others.
- **Playwright** in that app's project.
- **An MCP-capable coding agent.** TraceOn is tested with Claude Code.
  Other MCP clients can connect with the config template below, but they
  are untested.

## 1. Install TraceOn

```bash
npm install -g traceon-cli
```

## 2. Initialize it in your project

```bash
cd your-project
traceon init
```

At the backend prompt, choose **Embedded** (the default). `init`:

- downloads TraceOn's OpenTelemetry Collector (~95 MB, one-time,
  checksum-verified, from the official `opentelemetry-collector-releases`
  on GitHub) into `~/.traceon/bin/`
- writes `.traceon/config.json` in your project
- registers the MCP server with Claude Code (`~/.claude.json`) and
  Claude Desktop
- installs this skill into `.claude/skills/traceon-verify/`
- installs a Playwright fixture at `tests/traceon-fixture.js`

Add `.traceon/` to your `.gitignore`. Per-run evidence and any auth
tokens you give TraceOn are stored there.

## 3. Install Playwright (if the project doesn't have it)

```bash
npm install --save-dev @playwright/test
npx playwright install chromium
```

## 4. Point your backend's OpenTelemetry exporter at TraceOn

This is the one manual step. Set these on your backend process:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4319
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
```

If you already export traces somewhere else, keep that exporter and add
TraceOn as a second one. Per-language snippets (Node.js, Go, Python):
https://github.com/DhanushMurugesanG/TraceOn/blob/main/docs/embedded-mode-setup.md

## 5. Allow the `traceparent` header (frontend and backend on different origins)

TraceOn links browser actions to backend traces with the W3C
`traceparent` header. If your frontend calls a backend on another origin,
add `traceparent` (and `tracestate`) to the backend's CORS
`Access-Control-Allow-Headers`. Without it the browser blocks those
requests and TraceOn sees no backend spans. Snippets:
https://github.com/DhanushMurugesanG/TraceOn/blob/main/docs/auth-and-cors-setup.md

## 6. Connect your agent

- **Claude Code / Claude Desktop:** `traceon init` already registered the
  server. Fully quit the app and reopen it (Cmd+Q on macOS, not just
  closing the window).
- **Any other MCP client:** add the entry from `mcp-config.example.json`
  to that client's MCP server config, then restart the client.

  ```json
  { "mcpServers": { "traceon": { "command": "traceon", "args": ["mcp"] } } }
  ```

  If the client can't find `traceon` (common when Node is installed with
  nvm and the client is a GUI app), replace `"traceon"` with the full
  path that `which traceon` prints.

## 7. Check the setup

```bash
traceon doctor
```

This runs nine read-only checks in about 10 seconds: Playwright,
Chromium, frontend and backend reachable, CORS, collector installed, MCP
registration and skill version. Each failure prints the fix. The MCP
registration and skill-version checks look at Claude Code's config, so
on other clients you can ignore those two.

Then ask your agent for a small user-facing change, for example *"Add a
character counter under the textarea on the home page. Make sure it
works."* The agent writes the change and a Playwright test, calls
`traceon_verify`, and reports what the runtime evidence shows.

## Network access and local processes

- `traceon init` downloads the OpenTelemetry Collector binary from
  `github.com/open-telemetry/opentelemetry-collector-releases`. Nothing
  else is downloaded.
- During verification, TraceOn runs that collector locally on port 4319,
  and Playwright opens Chromium against your app's local URL.
- `traceon doctor` sends requests only to your app's frontend and backend
  URLs, and to your SigNoz URL if you use SigNoz.
- If you choose the SigNoz backend instead of Embedded, TraceOn queries
  the SigNoz URL you give it.
- TraceOn has no telemetry and sends nothing to its author or to Agensi.

## Already running SigNoz?

Choose **SigNoz** at the `traceon init` prompt and enter your SigNoz URL
and API key. For a non-Claude client, put those in the config entry:

```json
{
  "mcpServers": {
    "traceon": {
      "command": "traceon",
      "args": ["mcp"],
      "env": { "SIGNOZ_API_KEY": "<your key>", "SIGNOZ_BASE_URL": "http://localhost:8080" }
    }
  }
}
```

## Help

- Source, docs and issues: https://github.com/DhanushMurugesanG/TraceOn
- npm: https://www.npmjs.com/package/traceon-cli
- TraceOn is MIT-licensed open source.
