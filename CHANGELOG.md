# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0/).

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
