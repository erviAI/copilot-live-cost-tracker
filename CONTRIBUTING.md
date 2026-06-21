# Contributing to Copilot Cost Tracker

Thanks for your interest in contributing! This document explains how to set up
the project and the checks your changes are expected to pass.

## Project layout

- `extension/` — the VS Code extension (TypeScript, bundled with esbuild).
- `tools/` — developer-only scripts (not shipped with the extension).
- `docs/` — supporting documentation.

## Prerequisites

- Node.js 20.x
- npm 10.x

## Getting started

```bash
cd extension
npm ci
```

## Development workflow

All commands are run from the `extension/` directory:

| Command                 | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `npm run build`         | Bundle the extension with esbuild.               |
| `npm run watch`         | Rebuild on change.                               |
| `npm run typecheck`     | Type-check `src/` and `test/` with `tsc`.        |
| `npm run lint`          | Lint with ESLint.                                |
| `npm run format`        | Format with Prettier.                            |
| `npm test`              | Run the unit test suite (Vitest).                |
| `npm run test:coverage` | Run tests with coverage.                         |

Press `F5` in VS Code to launch an Extension Development Host for manual testing.

## Before opening a pull request

Please make sure the following all pass locally:

```bash
npm run lint
npm run typecheck
npm run build
npm test
```

CI runs these same checks on every pull request.

## Coding guidelines

- Keep the layering intact: `data → domain → services → presentation`. Domain
  and service code must not import the `vscode` API directly — depend on an
  interface and inject the implementation from `extension.ts`.
- Add or update unit tests for behavioural changes.
- Prefer small, focused pull requests with a clear description.

## Reporting bugs and requesting features

Please use the GitHub issue templates. Include your VS Code version, the
extension version, and reproduction steps where applicable.
