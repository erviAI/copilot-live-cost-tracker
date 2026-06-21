/**
 * SQLite access via a child process worker.
 * Spawns system Node.js with better-sqlite3 to avoid Electron ABI mismatch.
 * The worker process stays alive for the extension lifetime, communicating via NDJSON on stdin/stdout.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { logger } from '../logger.js';

export interface Database {
  all<T>(sql: string, params: unknown[]): Promise<T[]>;
  get<T>(sql: string, params: unknown[]): Promise<T | undefined>;
  close(): void;
}

/** Singleton worker process manager */
class WorkerProcess {
  private static instance: WorkerProcess | null = null;
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private starting: Promise<void> | null = null;

  static getInstance(): WorkerProcess {
    if (!WorkerProcess.instance) {
      WorkerProcess.instance = new WorkerProcess();
    }
    return WorkerProcess.instance;
  }

  private getWorkerPath(): string {
    // In bundled extension, the worker is alongside extension.js in dist/
    // In dev, it's in src/data/
    const distPath = path.join(__dirname, 'db-worker.js');
    if (fs.existsSync(distPath)) return distPath;
    const srcPath = path.join(__dirname, '..', 'src', 'data', 'db-worker.js');
    if (fs.existsSync(srcPath)) return srcPath;
    // Fallback: relative to this file's source location
    return path.join(__dirname, 'db-worker.js');
  }

  private async ensureStarted(): Promise<void> {
    if (this.process && !this.process.killed) return;
    if (this.starting) return this.starting;

    this.starting = new Promise<void>((resolve, reject) => {
      const workerPath = this.getWorkerPath();

      // Find a node binary that has access to better-sqlite3.
      // For VS Code extensions, we need the system node, not Electron's.
      const systemNode = findSystemNode();

      let settled = false;
      let startupTimer: ReturnType<typeof setTimeout> | null = null;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (startupTimer) clearTimeout(startupTimer);
        if (err) {
          this.process = null;
          this.starting = null;
          reject(err);
        } else {
          resolve();
        }
      };

      let child: ChildProcess;
      try {
        child = spawn(systemNode, [workerPath], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env },
        });
      } catch (err) {
        settle(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.process = child;

      // Spawn failures (e.g. ENOENT when node is not on PATH) surface via 'error',
      // not 'exit' — without this the worker would silently never become ready.
      child.on('error', (err) => {
        logger.error('[Worker] spawn error:', err);
        this.failAllPending(err);
        settle(err);
      });

      // Fail fast if the worker never announces readiness.
      startupTimer = setTimeout(() => {
        settle(new Error('Worker did not become ready within 10s'));
      }, 10_000);

      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (!line) continue;
          if (!settled) {
            // The first line is the readiness handshake.
            const handshake = this.tryParseHandshake(line);
            if (handshake === 'ready') { settle(); continue; }
            if (handshake && handshake.fatal) { settle(new Error(`Worker failed to start: ${handshake.fatal}`)); continue; }
          }
          this.handleResponse(line);
        }
      });

      child.stderr!.on('data', (chunk: Buffer) => {
        logger.error('[Worker]', chunk.toString());
      });

      child.on('exit', (code) => {
        this.process = null;
        this.starting = null;
        this.failAllPending(new Error(`Worker exited with code ${code}`));
        if (!settled) settle(new Error(`Worker exited before ready (code ${code})`));
      });
    });

    return this.starting;
  }

  /** Parse the startup handshake line; returns 'ready', a fatal payload, or null. */
  private tryParseHandshake(line: string): 'ready' | { fatal: string } | null {
    try {
      const msg = JSON.parse(line) as { ready?: boolean; fatal?: string };
      if (msg.ready === true) return 'ready';
      if (typeof msg.fatal === 'string') return { fatal: msg.fatal };
    } catch {
      // Not the handshake line.
    }
    return null;
  }

  /** Reject and clear all in-flight requests. */
  private failAllPending(err: Error): void {
    for (const [, { reject: rej }] of this.pending) {
      rej(err);
    }
    this.pending.clear();
  }

  private handleResponse(line: string): void {
    try {
      const msg = JSON.parse(line);
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result);
      }
    } catch {
      // Malformed response — ignore
    }
  }

  async send(action: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureStarted();
    if (!this.process || !this.process.stdin) {
      throw new Error('Worker process not available');
    }

    const id = ++this.requestId;
    const request = { id, action, ...payload };

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process!.stdin!.write(JSON.stringify(request) + '\n');

      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`Worker request timed out (action=${action})`));
        }
      }, 10_000);
    });
  }

  kill(): void {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    this.starting = null;
    WorkerProcess.instance = null;
  }
}

class WorkerDatabase implements Database {
  private handle: number | null = null;
  private readonly dbPath: string;
  private opening: Promise<void> | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  private async ensureOpen(): Promise<number> {
    if (this.handle !== null) return this.handle;
    if (this.opening) {
      await this.opening;
      return this.handle!;
    }

    this.opening = (async () => {
      const worker = WorkerProcess.getInstance();
      const result = await worker.send('open', { dbPath: this.dbPath }) as { handle: number };
      this.handle = result.handle;
    })();

    await this.opening;
    return this.handle!;
  }

  async all<T>(sql: string, params: unknown[]): Promise<T[]> {
    const handle = await this.ensureOpen();
    const worker = WorkerProcess.getInstance();
    const result = await worker.send('all', { handle, sql, params }) as { rows: T[] };
    return result.rows;
  }

  async get<T>(sql: string, params: unknown[]): Promise<T | undefined> {
    const handle = await this.ensureOpen();
    const worker = WorkerProcess.getInstance();
    const result = await worker.send('get', { handle, sql, params }) as { row: T | null };
    return result.row ?? undefined;
  }

  close(): void {
    if (this.handle !== null) {
      const worker = WorkerProcess.getInstance();
      worker.send('close', { handle: this.handle }).catch(() => {});
      this.handle = null;
      this.opening = null;
    }
  }
}

/**
 * Opens a SQLite database via the worker process.
 * Throws if the file does not exist.
 */
export async function openDatabase(dbPath: string): Promise<Database> {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }
  return new WorkerDatabase(dbPath);
}

/** Clean up the worker process (call on extension deactivation) */
export function disposeWorker(): void {
  WorkerProcess.getInstance().kill();
}

/**
 * Find the system Node.js binary (not Electron's).
 * On Windows, `node.exe` should be on PATH.
 */
function findSystemNode(): string {
  // Check common locations
  if (process.platform === 'win32') {
    // Try PATH first
    const pathNode = findOnPath('node.exe');
    if (pathNode) return pathNode;
    // Fallback to common install locations
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files';
    const candidate = path.join(programFiles, 'nodejs', 'node.exe');
    if (fs.existsSync(candidate)) return candidate;
  }
  // On macOS/Linux, node should be on PATH
  return 'node';
}

function findOnPath(binary: string): string | null {
  const pathEnv = process.env['PATH'] ?? '';
  const separator = process.platform === 'win32' ? ';' : ':';
  for (const dir of pathEnv.split(separator)) {
    const candidate = path.join(dir, binary);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
