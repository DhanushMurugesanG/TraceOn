#!/usr/bin/env node
// traceon CLI — `traceon init` registers the bundled MCP server with
// Claude Code and installs the traceon-verify skill in the current project.

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

  const rl = createInterface({ input, output });
  let apiKey, baseUrl;
  try {
    apiKey = (await rl.question('SigNoz API key (required): ')).trim();
    if (!apiKey) {
      console.error('\nAPI key is required. Generate one in SigNoz: Settings -> API Keys.');
      process.exit(1);
    }
    const baseUrlAnswer = (await rl.question('SigNoz base URL [http://localhost:8080]: ')).trim();
    baseUrl = baseUrlAnswer || 'http://localhost:8080';
  } finally {
    rl.close();
  }

  // 1. Register the MCP server with BOTH Claude products — Claude Desktop
  // (the GUI app at ~/Library/Application Support/Claude/...) and Claude
  // Code (the CLI at ~/.claude.json). They use different config files even
  // though both are called "Claude". Writing to both is harmless if the
  // user only has one installed — the unused config file just sits there.
  const serverEntry = {
    command: 'node',
    args: [mcpServerPath],
    env: {
      SIGNOZ_API_KEY: apiKey,
      SIGNOZ_BASE_URL: baseUrl,
    },
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
  console.log(`  ${stepN++}. Fully quit Claude Code (Cmd+Q on macOS, not just close the window) and reopen it.`);
  console.log(`  ${stepN++}. Verify the traceon_verify tool appears in the tool list.`);
  console.log(`  ${stepN++}. Ask Claude to add a feature in this project and TraceOn will verify it.`);
}

function usage() {
  console.log(`traceon v${pkg.version}

Usage:
  traceon init        Register MCP server with Claude Code and install
                      the traceon-verify skill in the current directory.

  traceon --version   Show version.
  traceon --help      Show this message.

Prerequisites for init:
  - SigNoz running locally (or accessible at a URL you'll be prompted for)
  - SigNoz API key (generate at <signoz-url>/settings/api-keys)
  - Claude Code installed`);
}

const args = process.argv.slice(2);
const cmd = args[0];

if (cmd === '--version' || cmd === '-v') {
  console.log(`traceon ${pkg.version}`);
  process.exit(0);
}
if (!cmd || cmd === '--help' || cmd === '-h') {
  usage();
  process.exit(0);
}
if (cmd === 'init') {
  await init();
  process.exit(0);
}

console.error(`Unknown command: ${cmd}`);
console.error(`Run \`traceon --help\` for usage.`);
process.exit(1);
