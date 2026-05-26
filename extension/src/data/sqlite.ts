/**
 * Thin abstraction over better-sqlite3 to provide a consistent API.
 * Isolates the native module dependency to a single file.
 * Uses synchronous better-sqlite3 which properly handles WAL mode.
 */

import * as fs from 'fs';
import BetterSqlite3 from 'better-sqlite3';

export interface Database {
  all<T>(sql: string, params: unknown[]): Promise<T[]>;
  get<T>(sql: string, params: unknown[]): Promise<T | undefined>;
  close(): void;
}

class BetterSqliteDatabase implements Database {
  private db: BetterSqlite3.Database;

  constructor(dbPath: string) {
    this.db = new BetterSqlite3(dbPath, { readonly: true, fileMustExist: true });
    // Enable WAL mode reading
    this.db.pragma('journal_mode = WAL');
  }

  async all<T>(sql: string, params: unknown[]): Promise<T[]> {
    return this.db.prepare(sql).all(...params) as T[];
  }

  async get<T>(sql: string, params: unknown[]): Promise<T | undefined> {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Opens a SQLite database in read-only mode.
 * Throws if the file does not exist.
 */
export async function openDatabase(dbPath: string): Promise<Database> {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }
  return new BetterSqliteDatabase(dbPath);
}
