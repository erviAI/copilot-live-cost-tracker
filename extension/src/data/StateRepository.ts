import type { ISessionTitleResolver } from './interfaces.js';
import { openDatabase, type Database } from './sqlite.js';

/**
 * Resolves session display titles from VS Code's state.vscdb.
 * The titles are stored in a JSON blob under a known key.
 */
export class StateRepository implements ISessionTitleResolver {
  private db: Database | null = null;
  private cache: Map<string, string> | null = null;
  private readonly dbPath: string;

  constructor(workspaceStoragePath: string) {
    // state.vscdb is at the root of the workspace storage folder
    this.dbPath = `${workspaceStoragePath}/state.vscdb`;
  }

  private async getDb(): Promise<Database> {
    if (!this.db) {
      this.db = await openDatabase(this.dbPath);
    }
    return this.db;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const db = await this.getDb();
      return db !== null;
    } catch {
      return false;
    }
  }

  async getTitle(sessionId: string): Promise<string | null> {
    const titles = await this.getAllTitles();
    return titles.get(sessionId) ?? null;
  }

  async getAllTitles(): Promise<Map<string, string>> {
    if (this.cache) {
      return this.cache;
    }

    const db = await this.getDb();
    const sql = `SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'`;
    const row = await db.get<{ value: string }>(sql, []);

    const titles = new Map<string, string>();
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
