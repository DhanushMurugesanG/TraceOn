# Contributing to TraceOn

Thanks for your interest in contributing! TraceOn is an MCP server that gives
AI coding agents real runtime verification. Contributions of all kinds —
bug reports, docs, tests, and code — are welcome.

## Ground rules

- Be respectful. This project follows our [Code of Conduct](CODE_OF_CONDUCT.md).
- For anything security-related, follow the [Security Policy](SECURITY.md) —
  do **not** open a public issue.
- Open an issue to discuss non-trivial changes before writing a large PR.

## Development setup

TraceOn is a pnpm monorepo.

**Prerequisites**

- Node.js 22+
- pnpm 11+

**Install & build**

```bash
pnpm install
pnpm build        # build all packages (pnpm -r build)
pnpm typecheck    # type-check all packages
pnpm test         # run the test suite
```

The workspace packages live under [`packages/`](packages/):

- `core` — trace collection, ranking, and verification logic
- `mcp` — the MCP server exposed to Claude Code
- `playwright-fixture` — the Playwright fixture that injects trace propagation

## Making a change

1. Fork the repo and create a branch off `main`
   (`git checkout -b fix/short-description`).
2. Make your change. Keep commits focused and write a clear message.
3. Run `pnpm typecheck` and `pnpm test` locally — both must pass.
4. Open a pull request against `main` using the PR template. Link any related
   issue and describe how you verified the change.

## Pull request checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
- [ ] New behavior is covered by tests where practical
- [ ] Docs (README / `docs/`) updated if user-facing behavior changed
- [ ] `CHANGELOG.md` updated for user-facing changes

## Commit style

We loosely follow [Conventional Commits](https://www.conventionalcommits.org/)
(e.g. `feat:`, `fix:`, `docs:`, `chore:`). It's not enforced, but it keeps the
history readable and the changelog easy to build.

## Reporting bugs

Open an issue with the bug report template. A minimal reproduction and the
output of `traceon` (with any relevant logs) helps enormously.
