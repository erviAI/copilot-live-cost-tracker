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

## Dependency updates

Dependabot raises grouped pull requests weekly. Dev-dependency patch and minor
updates merge themselves once CI passes; production dependencies and every major
are reviewed by hand. The grouping and ignore rules, with their rationale, live in
[.github/dependabot.yml](.github/dependabot.yml).

Auto-merge relies on two repository settings that are not visible in this repository:

- **Allow auto-merge** must stay enabled.
- The `Lint, typecheck, build & test` check must stay **required** on `main`.
  Without it, auto-merge lands bumps without waiting for CI.

If Dependabot pull requests stop appearing or ignore the configured rules, check the
`.github/dependabot.yml` status check on the last pull request that touched it. An
invalid config makes Dependabot fall back to the previous valid version silently.

## Pricing updates and releases

[.github/workflows/update-pricing.yml](.github/workflows/update-pricing.yml) runs every
Monday, regenerates `extension/src/domain/pricing-data.ts` from GitHub's published pricing
table, and then drives the release end to end: open the pull request, run CI on it, merge
it, merge the release pull request, tag the release, and publish all three platform VSIXs
to the Marketplace.

Three guards stop the automatic path. When any of them trips the pull request is left open,
labelled `needs-review`, and commented with the reason:

- a model disappeared from the published table (it is migrated to `extra-models.json` as
  deprecated, which is worth a human look),
- a rate moved by more than 25 percent, which usually means the upstream YAML changed shape
  rather than that Copilot repriced,
- the regenerated diff touched anything other than `pricing-data.ts` and `extra-models.json`.

To rehearse the chain without merging anything, dispatch it manually:

```bash
gh workflow run update-pricing.yml -f auto_merge=false
gh workflow run update-pricing.yml -f max_rate_delta_pct=5   # tighten the rate guard
```

The release pull request is cumulative, so an automatic pricing release also ships any
other commits merged since the last release. They have already passed CI and review, which
is why this is allowed.

### Why every step is dispatched explicitly

Anything a workflow creates using `GITHUB_TOKEN` cannot trigger another workflow by event:
pull requests it opens produce check runs stuck awaiting approval, and its pushes, tags and
releases raise no events at all. `workflow_dispatch` is the documented exception, so
[.github/scripts/dispatch-and-wait.sh](.github/scripts/dispatch-and-wait.sh) starts each
downstream workflow and blocks on the result. This is also why publishing is a job inside
[.github/workflows/release-please.yml](.github/workflows/release-please.yml) rather than a
listener on the `release: published` event.

Because of that, the `Lint, typecheck, build & test` job name in
[.github/workflows/ci.yml](.github/workflows/ci.yml) is load-bearing: it is the required
check's context name, and a dispatched CI run is what satisfies branch protection before the
bot merges.

Beyond the two settings above, the automated release train also needs:

- **Required pull request approvals must be off** for `main`. `github-actions[bot]` cannot
  approve, so an approval rule blocks the bot's merges outright.
- **Allow GitHub Actions to create and approve pull requests** enabled under
  Settings → Actions → General.
- A valid `VSCE_PAT` secret, and a `needs-review` label for held pull requests.

## Coding guidelines

- Keep the layering intact: `data → domain → services → presentation`. Domain
  and service code must not import the `vscode` API directly — depend on an
  interface and inject the implementation from `extension.ts`. See
  [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.
- Add or update unit tests for behavioural changes.
- Prefer small, focused pull requests with a clear description.

## Reporting bugs and requesting features

Please use the GitHub issue templates. Include your VS Code version, the
extension version, and reproduction steps where applicable.
