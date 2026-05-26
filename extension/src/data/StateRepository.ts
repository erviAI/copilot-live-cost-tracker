import * as fs from 'fs';
import * as path from 'path';
import type { ISessionTitleResolver } from './interfaces.js';
import { openDatabase, type Database } from './sqlite.js';

/**
 * Resolves session display titles from VS Code's state.vscdb.
 * The titles are stored in a JSON blob under a known key.
 * Non-fatal: returns empty titles if the database is unavailable.
 */
export class StateRepository implements ISessionTitleResolver {
  private db: Database | null = null;
  private cache: Map<string, string> | null = null;
  private readonly dbPath: string | null;

  constructor(workspaceStorageRoot: string | null) {
    // state.vscdb is at the root of the workspace storage folder
    this.dbPath = workspaceStorageRoot
      ? path.join(workspaceStorageRoot, 'state.vscdb')
      : null;
  }

  private async getDb(): Promise<Database | null> {
    if (!this.dbPath) return null;
    if (this.db) return this.db;
    if (!fs.existsSync(this.dbPath)) return null;
    try {
      this.db = await openDatabase(this.dbPath);
      return this.db;
    } catch {
      return null;
    }
  }

  async isAvailable(): Promise<boolean> {
    const db = await this.getDb();
    return db !== null;
  }

  async getTitle(sessionId: string): Promise<string | null> {
    const titles = await this.getAllTitles();
    return titles.get(sessionId) ?? null;
  }

  async getAllTitles(): Promise<Map<string, string>> {
    if (this.cache) {
      return this.cache;
    }

    const titles = new Map<string, string>();

    const db = await this.getDb();
    if (!db) return titles;

    const sql = `SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'`;
    const row = await db.get<{ value: string }>(sql, []);

    if (!row?.value) {
      return titles;
    }

    try {
      const parsed = JSON.parse(row.value) as {
        entries?: Record<string, { title?: string }>;
      };
      if (parsed.entries) {
        for (const [id, entry] of Object.entries(parsed.entries)) {
          if (entry.title) {
            titles.set(id, entry.title);
          }
        }
      }
    } catch {
      // Malformed JSON — return empty map
    }

    this.cache = titles;
    return titles;
  }

  /** Invalidate the cached titles (call when polling detects changes) */
  invalidateCache(): void {
    this.cache = null;
  }

  dispose(): void {
    this.db?.close();
    this.db = null;
    this.cache = null;
  }
}
