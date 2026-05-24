// Bundles the MCP server (packages/mcp + its workspace deps) into a single
// self-contained ESM file at dist/mcp.js. Native deps are kept external so
// the consumer installs them via package.json `dependencies`.
//
// Also copies the compiled Playwright fixture from
// packages/playwright-fixture/dist/index.js to lib/playwright-fixture.js
// so `traceon init` can stamp it into the user's project.
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

const result = await build({
  entryPoints: [resolve(repoRoot, 'packages/mcp/src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: resolve(repoRoot, 'dist/mcp.js'),
  external: ['better-sqlite3'],
  // ESM-friendly require shim so bundled CJS deps can `require` if needed.
  // The source file already has its own #!/usr/bin/env node shebang —
  // esbuild preserves it, so we don't add another here (would be a syntax
  // error on line 2).
  banner: {
    js: [
      'import { createRequire as __traceon_createRequire } from "node:module";',
      'const require = __traceon_createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
  metafile: false,
});

if (result.errors.length > 0) {
  console.error('Bundle had errors:', result.errors);
  process.exit(1);
}

console.log('Bundled MCP server -> dist/mcp.js');

// Copy the compiled Playwright fixture into lib/ so it ships in the tarball
// and `traceon init` can write it into the user's project as a regular file.
mkdirSync(resolve(repoRoot, 'lib'), { recursive: true });
copyFileSync(
  resolve(repoRoot, 'packages/playwright-fixture/dist/index.js'),
  resolve(repoRoot, 'lib/playwright-fixture.js'),
);
console.log('Copied Playwright fixture -> lib/playwright-fixture.js');
