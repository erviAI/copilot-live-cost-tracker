import * as path from 'path';
import type { ISessionMetadataRepository, SessionMetadata } from './interfaces.js';
import { openDatabase, type Database } from './sqlite.js';

const SESSION_STORE_RELATIVE = 'Code/User/globalStorage/github.copilot-chat/session-store.db';

/**
 * Reads session metadata from session-store.db.
 * Provides session names, agent info, timestamps, and turn data.
 */
export class SessionStoreRepository implements ISessionMetadataRepository {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(appDataPath: string) {
    this.dbPath = path.join(appDataPath, SESSION_STORE_RELATIVE);
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

  async getSessionMetadata(sessionId: string): Promise<SessionMetadata | null> {
    const db = await this.getDb();
    const sql = `
      SELECT id, summary, agent_name, created_at, updated_at, cwd, repository, branch
      FROM sessions
      WHERE id = ?
    `;
    const row = await db.get<SessionMetadataRow>(sql, [sessionId]);
    return row ? mapRow(row) : null;
  }

  async getRecentSessions(limit: number): Promise<SessionMetadata[]> {
    const db = await this.getDb();
    const sql = `
      SELECT id, summary, agent_name, created_at, updated_at, cwd, repository, branch
      FROM sessions
      ORDER BY updated_at DESC
      LIMIT ?
    `;
    const rows = await db.all<SessionMetadataRow>(sql, [limit]);
    return rows.map(mapRow);
  }

  /** Get user messages for each turn in a session, keyed by turn_index */
  async getTurnMessages(sessionId: string): Promise<Map<number, string>> {
    const db = await this.getDb();
    const sql = `SELECT turn_index, user_message FROM turns WHERE session_id = ? AND user_message IS NOT NULL ORDER BY turn_index`;
    const rows = await db.all<{ turn_index: number; user_message: string }>(sql, [sessionId]);
    const map = new Map<number, string>();
    for (const row of rows) {
      map.set(row.turn_index, row.user_message);
    }
    return map;
  }

  dispose(): void {
    this.db?.close();
    this.db = null;
  }
}

interface SessionMetadataRow {
  id: string;
  summary: string | null;
  agent_name: string | null;
  created_at: number;
  updated_at: number;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
}

function mapRow(row: SessionMetadataRow): SessionMetadata {
  return {
    id: row.id,
    summary: row.summary,
    agentName: row.agent_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cwd: row.cwd,
    repository: row.repository,
    branch: row.branch,
  };
}
