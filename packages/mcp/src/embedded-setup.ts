// Entry point for the dist/embedded-setup.js bundle — the pieces of
// embedded mode that `traceon init` (plain-JS bin/cli.js) needs at setup
// time: the lazy collector-binary install and the default OTLP port for
// the user-facing exporter snippet.
export { ensureCollectorBinary, OTELCOL_VERSION, DEFAULT_OTLP_PORT } from '@traceon/core';
