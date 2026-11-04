// Builds build/agensi/traceon-verify.zip for the Agensi marketplace listing:
// the traceon-verify skill (single source: skills/traceon-verify/SKILL.md, so
// the listing never drifts from what `traceon init` installs) plus the setup
// guide and MCP config template from packaging/agensi/.
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');
const outDir = resolve(repoRoot, 'build/agensi');
const stageDir = resolve(outDir, 'traceon-verify');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });

copyFileSync(resolve(repoRoot, 'skills/traceon-verify/SKILL.md'), resolve(stageDir, 'SKILL.md'));
for (const file of ['SETUP.md', 'mcp-config.example.json']) {
  copyFileSync(resolve(repoRoot, 'packaging/agensi', file), resolve(stageDir, file));
}

// -X drops macOS extended attributes so the archive is the same on every OS.
execFileSync('zip', ['-r', '-X', 'traceon-verify.zip', 'traceon-verify'], {
  cwd: outDir,
  stdio: 'inherit',
});
console.log(`Packaged Agensi listing -> ${resolve(outDir, 'traceon-verify.zip')}`);
