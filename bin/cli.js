#!/usr/bin/env node
// traceon CLI — `traceon init` registers the bundled MCP server with
// Claude Code and installs the traceon-verify skill in the current project.
// `traceon mcp` runs that server directly, for MCP clients init doesn't
// configure.

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const mcpServerPath = join(packageRoot, 'dist', 'mcp.js');
const skillSource = join(packageRoot, 'skills', 'traceon-verify', 'SKILL.md');
const fixtureSource = join(packageRoot, 'lib', 'playwright-fixture.js');

const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'));

function projectHasPlaywright(cwd) {
  const pkgJsonPath = join(cwd, 'package.json');
  if (!existsSync(pkgJsonPath)) return false;
  try {
    const projPkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const deps = { ...(projPkg.dependencies ?? {}), ...(projPkg.devDependencies ?? {}) };
    return Boolean(deps['@playwright/test']);
  } catch {
    return false;
  }
}

function claudeDesktopConfigPath() {
  const p = platform();
  if (p === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (p === 'linux') {
    return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
  }
  throw new Error(`TraceOn doesn't support ${p} yet. macOS and Linux only.`);
}

// Claude Code (the CLI, not the Desktop app) reads ~/.claude.json across all
// platforms. user-scope mcpServers live at the top level of that file.
function claudeCodeConfigPath() {
  return join(homedir(), '.claude.json');
}

// Write the traceon server entry into a Claude config file, preserving any
// other keys / servers already present. Creates parent dirs and the file if
// missing. Returns the path written.
function writeMcpServerToConfig(cfgPath, serverEntry) {
  mkdirSync(dirname(cfgPath), { recursive: true });
  let config = {};
  if (existsSync(cfgPath)) {
    try {
      config = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    } catch {
      console.error(`Existing Claude config at ${cfgPath} is not valid JSON.`);
      console.error('Move or fix it before running init.');
      process.exit(1);
    }
  }
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers.traceon = serverEntry;
  writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n');
  return cfgPath;
}

async function init() {
  console.log(`traceon v${pkg.version} — init\n`);

  if (!existsSync(mcpServerPath)) {
    console.error(`Bundled MCP server not found at ${mcpServerPath}.`);
    console.error('This usually means the package install is incomplete. Try reinstalling.');
    process.exit(1);
  }
  if (!existsSync(skillSource)) {
    console.error(`Skill file not found at ${skillSource}.`);
    process.exit(1);
  }
  if (!existsSync(fixtureSource)) {
    console.error(`Playwright fixture not found at ${fixtureSource}.`);
    process.exit(1);
  }

  // Backend choice. Embedded is the default: no Docker, no SigNoz, no API
  // key — TraceOn downloads its own OTel Collector on first init. SigNoz
  // stays fully supported for users who already run it.
  const rl = createInterface({ input, output });
  let backendChoice, apiKey, baseUrl, otlpPort;
  try {
    console.log('Choose a trace backend:');
    console.log('  1. Embedded (recommended) — TraceOn runs its own collector. No Docker, no API key.');
    console.log('  2. SigNoz — bring your own SigNoz install.');
    const choice = (await rl.question('Backend [1]: ')).trim();
    backendChoice = choice === '2' ? 'signoz' : 'embedded';

    if (backendChoice === 'signoz') {
      apiKey = (await rl.question('SigNoz API key (required): ')).trim();
      if (!apiKey) {
        console.error('\nAPI key is required. Generate one in SigNoz: Settings -> API Keys.');
        process.exit(1);
      }
      const baseUrlAnswer = (await rl.question('SigNoz base URL [http://localhost:8080]: ')).trim();
      baseUrl = baseUrlAnswer || 'http://localhost:8080';
    }
  } finally {
    rl.close();
  }

  if (backendChoice === 'embedded') {
    // Lazy-download the pinned otelcol-contrib binary (~95 MB, one-time,
    // checksum-verified into ~/.traceon/bin). Loaded dynamically so the
    // SigNoz path never pays for this module.
    const setupBundle = join(packageRoot, 'dist', 'embedded-setup.js');
    if (!existsSync(setupBundle)) {
      console.error(`Embedded setup bundle not found at ${setupBundle}.`);
      console.error('This usually means the package install is incomplete. Try reinstalling.');
      process.exit(1);
    }
    const { ensureCollectorBinary, DEFAULT_OTLP_PORT } = await import(setupBundle);
    otlpPort = DEFAULT_OTLP_PORT;
    console.log('');
    try {
      await ensureCollectorBinary({ onProgress: (m) => console.log(`  ${m}`) });
    } catch (err) {
      console.error(`\nCollector install failed: ${err.message}`);
      if (err.userGuidance) console.error(err.userGuidance);
      process.exit(1);
    }

    // Project-scoped backend selection. The MCP server reads this (resolved
    // from the test file's project root) on every verify call.
    const configDest = join(process.cwd(), '.traceon', 'config.json');
    mkdirSync(dirname(configDest), { recursive: true });
    writeFileSync(
      configDest,
      JSON.stringify({ backend: 'embedded', embedded: { port: otlpPort } }, null, 2) + '\n',
    );
    console.log(`[ok] Wrote backend config to ${configDest}`);
  }

  // 1. Register the MCP server with BOTH Claude products — Claude Desktop
  // (the GUI app at ~/Library/Application Support/Claude/...) and Claude
  // Code (the CLI at ~/.claude.json). They use different config files even
  // though both are called "Claude". Writing to both is harmless if the
  // user only has one installed — the unused config file just sits there.
  // Embedded mode needs no env config — backend selection lives in the
  // project's .traceon/config.json.
  const serverEntry = {
    command: 'node',
    args: [mcpServerPath],
    env: backendChoice === 'signoz'
      ? { SIGNOZ_API_KEY: apiKey, SIGNOZ_BASE_URL: baseUrl }
      : {},
  };
  const desktopPath = writeMcpServerToConfig(claudeDesktopConfigPath(), serverEntry);
  console.log(`\n[ok] Registered traceon in Claude Desktop config: ${desktopPath}`);
  const codePath = writeMcpServerToConfig(claudeCodeConfigPath(), serverEntry);
  console.log(`[ok] Registered traceon in Claude Code config:    ${codePath}`);

  // 2. Copy the skill into the current project's .claude/skills/
  const skillDest = join(process.cwd(), '.claude', 'skills', 'traceon-verify', 'SKILL.md');
  mkdirSync(dirname(skillDest), { recursive: true });
  copyFileSync(skillSource, skillDest);
  console.log(`[ok] Installed traceon-verify skill at ${skillDest}`);

  // 3. Copy the Playwright fixture into the project's tests/ directory.
  // Tests will import it as `import { test, expect } from './traceon-fixture.js'`.
  const fixtureDest = join(process.cwd(), 'tests', 'traceon-fixture.js');
  mkdirSync(dirname(fixtureDest), { recursive: true });
  copyFileSync(fixtureSource, fixtureDest);
  console.log(`[ok] Installed Playwright fixture at ${fixtureDest}`);

  // 4. Detect whether @playwright/test is already installed in this project.
  const hasPlaywright = projectHasPlaywright(process.cwd());

  // 5. Next steps
  console.log('\nNext steps:');
  let stepN = 1;
  if (!hasPlaywright) {
    console.log(`  ${stepN++}. Install Playwright in this project:`);
    console.log('       pnpm add -D @playwright/test     (or `npm install --save-dev @playwright/test`)');
    console.log('       pnpm exec playwright install chromium');
  }
  if (backendChoice === 'embedded') {
    console.log(`  ${stepN++}. Point your backend's OTel exporter at TraceOn's collector:`);
    console.log(`       OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${otlpPort}`);
    console.log('       OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf');
    console.log('     (or the equivalent exporter config in your OTel SDK bootstrap —');
    console.log('      keep any existing exporters and add this as a second target if');
    console.log('      you already ship traces elsewhere)');
  }
  console.log(`  ${stepN++}. Fully quit Claude Code (Cmd+Q on macOS, not just close the window) and reopen it.`);
  console.log(`  ${stepN++}. Verify the traceon_verify tool appears in the tool list.`);
  console.log(`  ${stepN++}. Ask Claude to add a feature in this project and TraceOn will verify it.`);
}

function usage() {
  console.log(`traceon v${pkg.version}

Usage:
  traceon init        Register MCP server with Claude Code and install
                      the traceon-verify skill in the current directory.

  traceon doctor      Run preflight checks for the most common setup
                      issues (Playwright installed, backend CORS allows
                      traceparent, SigNoz reachable, etc.). Exits 0 if
                      everything looks good, 1 if any check failed.

  traceon mcp         Start the MCP server over stdio. init already
                      registers it with Claude Code and Claude Desktop;
                      use this as the command in any other MCP client's
                      config: { "command": "traceon", "args": ["mcp"] }

  traceon --version   Show version.
  traceon --help      Show this message.

Prerequisites for init:
  - Claude Code installed
  - Embedded backend (default): nothing else — the OTel collector is
    downloaded automatically on first init (~95 MB, one-time)
  - SigNoz backend: SigNoz running locally + an API key
    (generate at <signoz-url>/settings/api-keys)`);
}

const doctorScriptPath = join(packageRoot, 'dist', 'doctor.js');

async function doctor() {
  if (!existsSync(doctorScriptPath)) {
    console.error(`Bundled doctor runner not found at ${doctorScriptPath}.`);
    console.error('This usually means the package install is incomplete. Try reinstalling.');
    process.exit(1);
  }
  // Dynamic import so we don't pay the cost (or the load-time risk) of the
  // doctor module when other subcommands are invoked.
  const { runDoctor } = await import(doctorScriptPath);
  const useColor = Boolean(process.stdout.isTTY) && process.env.NO_COLOR == null;
  // Unicode glyphs render on every modern terminal we target except old
  // Windows consoles. Light heuristic: enable everywhere except Win + non-WT.
  const useUnicode = !(process.platform === 'win32' && !process.env.WT_SESSION);
  const result = await runDoctor({ cwd: process.cwd(), useColor, useUnicode });
  process.stdout.write(result.rendered + '\n');
  process.exit(result.ok ? 0 : 1);
}

async function mcp() {
  if (!existsSync(mcpServerPath)) {
    console.error(`Bundled MCP server not found at ${mcpServerPath}.`);
    console.error('This usually means the package install is incomplete. Try reinstalling.');
    process.exit(1);
  }
  // stdout is the MCP transport from here on — never print to it. The server
  // module connects on import and exits itself when the client closes stdin.
  await import(mcpServerPath);
}

const args = process.argv.slice(2);
const cmd = args[0];

// `--help` / `-h` after a subcommand (e.g. `traceon init --help`) should print
// usage, not run the subcommand. The dispatch below keys on args[0], so without
// this the flag lands in args[1] and gets ignored.
const wantsHelp = (rest) => rest.includes('--help') || rest.includes('-h');

if (cmd === '--version' || cmd === '-v') {
  console.log(`traceon ${pkg.version}`);
  process.exit(0);
}
if (!cmd || cmd === '--help' || cmd === '-h') {
  usage();
  process.exit(0);
}
if (cmd === 'init') {
  if (wantsHelp(args.slice(1))) {
    usage();
    process.exit(0);
  }
  await init();
  process.exit(0);
}
if (cmd === 'doctor') {
  if (wantsHelp(args.slice(1))) {
    usage();
    process.exit(0);
  }
  await doctor();
  // doctor() handles its own process.exit
}
if (cmd === 'mcp') {
  if (wantsHelp(args.slice(1))) {
    usage();
    process.exit(0);
  }
  // Long-running: don't fall through to the unknown-command exit below.
  await mcp();
} else {
  console.error(`Unknown command: ${cmd}`);
  console.error(`Run \`traceon --help\` for usage.`);
  process.exit(1);
}
