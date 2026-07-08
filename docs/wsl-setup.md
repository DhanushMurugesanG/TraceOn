# WSL setup (Windows / WSL2 Ubuntu)

TraceOn runs on WSL2 the same way it runs on native Linux. This guide covers
the gotchas a first-time WSL user hits — filesystem placement, Node under
nvm, and the Playwright browser system dependencies Ubuntu lacks by default.

## Prerequisites

- **WSL2** with a recent Ubuntu (22.04 / 24.04).
- **Keep your project inside the WSL filesystem** (`~/...`), not
  `/mnt/c/...`. Playwright and file-watching are slow or broken on the
  Windows mount — always clone and work under your Linux home.
- **Node 20+** installed inside WSL.
- If your backend is Python, **Python 3.12** is fine.

## Node via nvm

nvm-installed Node means `traceon` (installed with `npm i -g`) lands in
nvm's global bin (`~/.nvm/versions/node/<version>/bin`). Make sure that dir
is on `PATH` and that both resolve **inside WSL**:

```bash
which node      # → ~/.nvm/versions/node/.../bin/node, not /mnt/c/...
which traceon   # → same nvm bin dir
```

If Claude Code can't find the MCP server after `traceon init`, a
Windows-vs-WSL node mismatch is the usual cause — a Windows `node.exe` on
your inherited PATH shadows the WSL one.

## Playwright browser system dependencies

The key WSL gotcha. Installing the npm package is **not enough**: Chromium
needs system libraries that Ubuntu/WSL doesn't ship by default. Install the
browser binary, then the system libs:

```bash
npx playwright install chromium      # browser binary
sudo npx playwright install-deps     # official system-lib installer
```

If `install-deps` isn't available, install the libs manually via apt:

```bash
sudo apt install -y libnss3 libatk-bridge2.0-0 libatk1.0-0 libcups2 \
  libgbm1 libasound2 libxcomposite1 libxdamage1 libxrandr2 \
  libxkbcommon0 libpango-1.0-0 libcairo2
```

Symptom without these: Chromium fails to launch with `error while loading
shared libraries: libnss3.so` or `Host system is missing dependencies`.

## Embedded collector on WSL

The `otelcol-contrib` binary TraceOn downloads is a native Linux binary.
Inside WSL it downloads and runs fine — no Windows interop needed. The OTLP
receiver on `http://localhost:4319` is reachable from your WSL backend
normally.

## Verify with traceon doctor

Run `traceon doctor` in your project. As of v0.2.1 it actually launches
headless Chromium, so it catches the missing-deps case above (it used to
false-green). When deps are missing, its guidance points you to
`sudo npx playwright install-deps`.

## Common errors → fixes

| Symptom | Fix |
| --- | --- |
| `libnss3.so` / shared libraries error | `sudo npx playwright install-deps` |
| `traceon: command not found` after `npm i -g` | nvm global-bin dir not on PATH |
| `Executable doesn't exist … run npx playwright install` | `npx playwright install chromium` |
| Slow / no file changes detected | Move project off `/mnt/c` into `~/` |
