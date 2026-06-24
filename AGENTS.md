# Agent Instructions

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
