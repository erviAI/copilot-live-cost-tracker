/**
 * Preflight check for the native `better-sqlite3` binding.
 *
 * The extension reads agent-traces.db through a worker that runs the *system*
 * Node.js found on PATH (see src/data/sqlite.ts -> findSystemNode). The compiled
 * `better_sqlite3.node` must match that Node's ABI (NODE_MODULE_VERSION). When
 * the system Node is upgraded, the prebuilt binary goes stale and every poll
 * fails silently. This script runs under that same PATH Node, so it reproduces
 * exactly what the worker will see — and rebuilds the binding when it's stale.
 *
 * Wired into the `build`/`watch` npm scripts so it runs automatically on F5.
 * Fast and silent on the happy path; only acts when there's a real mismatch.
 */
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import process from 'node:process';

const require = createRequire(import.meta.url);

/** Try to load the native binding. Returns the Error on failure, or null on success. */
function tryLoad() {
  try {
    require('better-sqlite3');
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

const firstError = tryLoad();
if (!firstError) {
  process.exit(0); // Binding loads fine — nothing to do.
}

const message = firstError.message;
const isAbiMismatch = /NODE_MODULE_VERSION|compiled against a different Node\.js version|was compiled against/i.test(message);

if (!isAbiMismatch) {
  // A different problem (e.g. the module isn't installed). Don't silently rebuild —
  // surface it so the developer can run `npm install`.
  console.error('[check-native] better-sqlite3 failed to load (not an ABI mismatch):');
  console.error('  ' + message);
  console.error('[check-native] Try running "npm install" in the extension folder.');
  process.exit(1);
}

console.warn(`[check-native] better-sqlite3 is built for a different Node.js ABI than ${process.version}. Rebuilding...`);
try {
  execSync('npm rebuild better-sqlite3', { stdio: 'inherit' });
} catch {
  console.error('[check-native] "npm rebuild better-sqlite3" failed. Please run it manually in the extension folder.');
  process.exit(1);
}

const secondError = tryLoad();
if (secondError) {
  console.error('[check-native] better-sqlite3 still fails to load after rebuild:');
  console.error('  ' + secondError.message);
  process.exit(1);
}

console.log(`[check-native] better-sqlite3 rebuilt successfully for Node ${process.version}.`);
process.exit(0);
