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

const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf-8'));

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

  // 1. Update Claude Code's MCP config
  const cfgPath = claudeDesktopConfigPath();
  mkdirSync(dirname(cfgPath), { recursive: true });
  let config = {};
  if (existsSync(cfgPath)) {
    try {
      config = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    } catch {
      console.error(`Existing Claude Code config at ${cfgPath} is not valid JSON.`);
      console.error('Move or fix it before running init.');
      process.exit(1);
    }
  }
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers.traceon = {
    command: 'node',
    args: [mcpServerPath],
    env: {
      SIGNOZ_API_KEY: apiKey,
      SIGNOZ_BASE_URL: baseUrl,
    },
  };
  writeFileSync(cfgPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`\n[ok] Registered traceon MCP server in ${cfgPath}`);

  // 2. Copy the skill into the current project's .claude/skills/
  const skillDest = join(process.cwd(), '.claude', 'skills', 'traceon-verify', 'SKILL.md');
  mkdirSync(dirname(skillDest), { recursive: true });
  copyFileSync(skillSource, skillDest);
  console.log(`[ok] Installed traceon-verify skill at ${skillDest}`);

  // 3. Next steps
  console.log('\nNext steps:');
  console.log('  1. Fully quit Claude Code (Cmd+Q on macOS, not just close the window) and reopen it.');
  console.log('  2. Verify the traceon_verify tool appears in the tool list.');
  console.log('  3. Ask Claude to add a feature in this project and TraceOn will verify it.');
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
