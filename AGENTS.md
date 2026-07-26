# Agent Instructions

## Branching and pull requests

All feature development must happen on a `feat/` branch — never commit feature work directly to `main`.

- Create a branch before starting work: `git checkout -b feat/<short-description>`
- Changes reach `main` only through a pull request; direct pushes to `main` are not allowed.
- Open the PR against `main` and let CI pass before merging.

## Running NPM commands

All NPM commands must be run from the `extension/` subfolder, **not** the repository root. The `package.json` with the project's scripts and dependencies lives in `extension/`.

```bash
cd extension
npm install
npm run build
```

Common scripts (run from `extension/`):

- `npm run build` — type-check native deps and bundle with esbuild
- `npm run watch` — rebuild on change
- `npm run typecheck` — TypeScript type checking
- `npm run lint` — ESLint
- `npm run test` — run the Vitest suite
- `npm run package` — produce the `.vsix`
<>