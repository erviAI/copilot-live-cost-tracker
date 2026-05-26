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
