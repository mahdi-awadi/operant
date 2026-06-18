# Contributing to Operant

Thanks for your interest in contributing! This document describes the workflow for working on Operant.

## Branches

- **`main`** — stable, production-ready. Tagged releases come from here.
- **`develop`** — integration branch for ongoing work. All PRs target this branch.
- **Feature branches** — `feature/<description>`, branched from `develop`
- **Fix branches** — `fix/<description>`, branched from `develop`
- **Release branches** — `release/vX.Y.Z`, branched from `develop`, merged to `main` and back to `develop`

## Development Workflow

1. **Fork** the repo on GitHub
2. **Clone** your fork locally
3. **Check out `develop`** and create a feature branch:
   ```bash
   git checkout develop
   git pull upstream develop
   git checkout -b feature/my-new-thing
   ```
4. **Make your changes** following the existing code style
5. **Write tests** for new functionality
6. **Run the full test suite**:
   ```bash
   bun test
   ```
7. **Commit** with a clear message (see below)
8. **Push** to your fork
9. **Open a Pull Request** against `develop`

## Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: ...` — new feature
- `fix: ...` — bug fix
- `docs: ...` — documentation only
- `refactor: ...` — code change that neither fixes a bug nor adds a feature
- `test: ...` — adding or updating tests
- `chore: ...` — tooling, build, dependencies
- `perf: ...` — performance improvement

Keep the first line under 72 characters. Add a body for non-trivial changes.

## Code Style

- **TypeScript strict mode** — no `any` unless unavoidable
- **Small, focused files** — one clear responsibility per file
- **Named exports** — avoid default exports
- **No implicit error swallowing** — always log or rethrow
- **Comments explain why, not what** — the code should show what

## Testing

- Every new feature needs tests
- Bug fixes need a regression test
- Use `bun test` to run the suite
- Tests live in `tests/` mirroring `src/` structure

## Pull Requests

- Target `develop`, not `main`
- Include a clear description of what changed and why
- Link related issues (`Fixes #123`, `Closes #456`)
- Keep PRs focused — one change per PR
- All tests must pass
- Address review feedback before merging

## Releases

Releases are cut from `main` and tagged `vX.Y.Z`:

1. Create a release branch from `develop`: `release/vX.Y.Z`
2. Update version in `package.json` and `.claude-plugin/plugin.json`
3. Update `CHANGELOG.md`
4. Merge release branch to `main`
5. Tag the merge commit: `git tag vX.Y.Z && git push --tags`
6. Merge `main` back to `develop`

## Reporting Bugs

Open an issue with:
- Your OS and Bun version
- Steps to reproduce
- Expected vs actual behavior
- Relevant daemon logs (`~/.operant/` tmux session)

## Security

Don't open public issues for security vulnerabilities. Email the maintainer directly.

## License

By contributing, you agree that your contributions will be licensed under the Apache-2.0 license.
