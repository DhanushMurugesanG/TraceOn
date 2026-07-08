# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

## [0.2.1] - 2026-06-16

First fixes from external alpha testing. Reported by **Thirumalaiboobathi**
(Madurai AI Community) — TraceOn's first external user — who tested v0.2.0 on
WSL2 Ubuntu with a FastAPI + OpenTelemetry backend and a React frontend (both
verifications passed end-to-end). With thanks.

### Fixed

- `traceon init --help` and `traceon doctor --help` now print usage instead of
  running the subcommand — the CLI had dispatched only on the first argument, so
  a `--help` after a subcommand was ignored.
- `traceon doctor` now **actually launches headless Chromium**, catching WSL2 /
  minimal-Linux setups where the browser can't start because system libraries
  (libnss3, libatk-bridge, …) are missing. Previously "Playwright is installed"
  showed green while Chromium couldn't launch — false confidence. The fix points
  to `sudo npx playwright install-deps`.

### Added

- `docs/wsl-setup.md` — a WSL2 setup guide: filesystem placement (keep the
  project off `/mnt/c`), Node under nvm, the Playwright browser
  system-dependency gotcha, and a symptom→fix table.

### Documentation

- Documented the FastAPI / ASGI `code.filepath` attribution gap (an upstream
  `opentelemetry-python-contrib` limitation, not a TraceOn bug): Python backend
  files show up in `coverage.misses` with `attribution_limited: true` even
  though they ran — verify by asserting on the response body. (README Limits +
  `docs/embedded-mode-setup.md`.)

## [0.2.0] - 2026-06-16

> Currently published to npm under the `next` dist-tag — install with
> `npm i -g traceon-cli@next`. The `latest` tag remains `0.0.11`.

### Added

- Embedded OTel collector mode (now the default) — no Docker, no SigNoz, and no API key required.
- Lazy-downloaded `otelcol-contrib` binary, pinned to `0.154.0`, fetched on first `traceon init` and checksum-verified into `~/.traceon/bin`.
- OTLP/HTTP receiver on port `:4319` for backend telemetry; the user's backend exports OTLP straight to the local collector (single env change, or a second exporter target via the dual-exporter pattern).
- File-exporter pipeline that writes spans and logs to evidence.
- `EvidenceBackend` interface with pluggable backends; evidence (spans/logs) is identical regardless of backend.
- `.traceon/config.json` project config with a `backend` discriminated union and a tunable `embedded.settle` block.
- `traceon init` prompt to choose between embedded and SigNoz backends.
- Backend-aware `traceon doctor` check.
- `docs/embedded-mode-setup.md` setup guide.

### Changed

- Embedded is now the default backend at `traceon init`.
- README quickstart now leads with embedded mode.
- SigNoz is now documented as "bring your own backend".

### Fixed

These were caught in code review before publish:

- Config-aware embedded singleton — a second project no longer silently reuses the wrong collector.
- `embedded.settle` validation now rejects a `pollMs: 0` busy-loop and `NaN` values.
- Collector spawn errors (e.g. `ENOENT`) are surfaced with the real underlying cause.
- Collector-config paths are now quoted.
- Trace-file pre-filter so large files are not re-parsed on each poll.
- `traceon doctor` now honors a SigNoz `baseUrl` set in the config file.

### Notes

- Backward compatible: existing SigNoz env-var configurations continue to work unchanged.

## History

Earlier `0.0.x` releases (up to `0.0.11`, the current `latest`) were pre-release alphas.
