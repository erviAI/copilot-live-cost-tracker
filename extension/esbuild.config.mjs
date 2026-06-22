import * as esbuild from 'esbuild';
import * as fs from 'fs';
import * as path from 'path';

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const buildOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  sourcemap: watch,
  minify: !watch,
};

/**
 * Browser bundle for the dashboard webview panel. Chart.js is bundled in here
 * (it runs in the webview's browser context, not Node).
 * @type {import('esbuild').BuildOptions}
 */
const webviewOptions = {
  entryPoints: ['src/webview/dashboard.ts'],
  bundle: true,
  outfile: 'dist/webview/dashboard.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  sourcemap: watch,
  minify: !watch,
};

// Copy the worker script to dist/ (it runs in a separate node process)
function copyWorker() {
  const src = path.resolve('src/data/db-worker.js');
  const dest = path.resolve('dist/db-worker.js');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

if (watch) {
  const ctx = await esbuild.context(buildOptions);
  const webviewCtx = await esbuild.context(webviewOptions);
  await ctx.watch();
  await webviewCtx.watch();
  copyWorker();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  await esbuild.build(webviewOptions);
  copyWorker();
  console.log('Build complete.');
}
