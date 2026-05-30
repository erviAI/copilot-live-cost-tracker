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
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
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
      const nodePath = process.execPath; // Use same node as the system

      // Find a node binary that has access to better-sqlite3
      // For VS Code extensions, we need the system node, not Electron's
      const systemNode = findSystemNode();

      this.process = spawn(systemNode, [workerPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env },
      });

      this.process.stdout!.setEncoding('utf8');
      this.process.stdout!.on('data', (chunk: string) => {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, idx).trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (line) this.handleResponse(line);
        }
      });

      this.process.stderr!.on('data', (chunk: Buffer) => {
        logger.error('[Worker]', chunk.toString());
      });

      this.process.on('exit', (code) => {
        this.process = null;
        this.starting = null;
        // Reject all pending requests
        for (const [, { reject: rej }] of this.pending) {
          rej(new Error(`Worker exited with code ${code}`));
        }
        this.pending.clear();
      });

      // Give the process a moment to start, then resolve
      // (The worker is ready as soon as stdin/stdout are connected)
      setTimeout(() => resolve(), 50);
    });

    return this.starting;
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

  async send(action: string, payload: Record<string, unknown> = {}): Promise<any> {
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
      const result = await worker.send('open', { dbPath: this.dbPath });
      this.handle = result.handle;
    })();

    await this.opening;
    return this.handle!;
  }

  async all<T>(sql: string, params: unknown[]): Promise<T[]> {
    const handle = await this.ensureOpen();
    const worker = WorkerProcess.getInstance();
    const result = await worker.send('all', { handle, sql, params });
    return result.rows as T[];
  }

  async get<T>(sql: string, params: unknown[]): Promise<T | undefined> {
    const handle = await this.ensureOpen();
    const worker = WorkerProcess.getInstance();
    const result = await worker.send('get', { handle, sql, params });
    return result.row as T | undefined;
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
