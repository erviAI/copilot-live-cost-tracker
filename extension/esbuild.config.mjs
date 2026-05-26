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
  sourcemap: true,
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
  await ctx.watch();
  copyWorker();
  console.log('Watching for changes...');
} else {
  await esbuild.build(buildOptions);
  copyWorker();
  console.log('Build complete.');
}
