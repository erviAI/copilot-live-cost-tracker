import * as path from 'path';
import type { ISpanRepository } from './interfaces.js';
import type { Span } from '../domain/models.js';
import { openDatabase, type Database } from './sqlite.js';

const AGENT_TRACES_RELATIVE = 'Code/User/globalStorage/github.copilot-chat/agent-traces.db';

/**
 * Reads token/span data from agent-traces.db (OpenTelemetry format).
 * Opens the database read-only; handles WAL via native SQLite.
 */
export class AgentTracesRepository implements ISpanRepository {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(appDataPath: string) {
    this.dbPath = path.join(appDataPath, AGENT_TRACES_RELATIVE);
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

  async getSpansForSession(sessionId: string): Promise<Span[]> {
    const db = await this.getDb();
    const sql = `
      SELECT
        s.span_id,
        s.trace_id,
        s.operation_name,
        s.request_model,
        s.response_model,
        s.input_tokens,
        s.output_tokens,
        s.cached_tokens,
        CAST(COALESCE(a.value, '0') AS INTEGER) AS cache_write_tokens,
        COALESCE(s.reasoning_tokens, 0) AS reasoning_tokens,
        s.start_time_ms,
        s.end_time_ms,
        s.ttft_ms,
        s.chat_session_id,
        s.conversation_id,
        s.turn_index,
        s.status_code,
        s.status_message,
        s.tool_name
      FROM spans s
      LEFT JOIN span_attributes a
        ON a.span_id = s.span_id
        AND a.key = 'gen_ai.usage.cache_creation.input_tokens'
      WHERE s.operation_name = 'chat'
        AND (s.chat_session_id = ? OR s.conversation_id = ?)
      ORDER BY s.start_time_ms ASC
    `;
    return db.all<Span>(sql, [sessionId, sessionId]);
  }

  async getSpansSince(timestampMs: number): Promise<Span[]> {
    const db = await this.getDb();
    const sql = `
      SELECT
        s.span_id,
        s.trace_id,
        s.operation_name,
        s.request_model,
        s.response_model,
        s.input_tokens,
        s.output_tokens,
        s.cached_tokens,
        CAST(COALESCE(a.value, '0') AS INTEGER) AS cache_write_tokens,
        COALESCE(s.reasoning_tokens, 0) AS reasoning_tokens,
        s.start_time_ms,
        s.end_time_ms,
        s.ttft_ms,
        s.chat_session_id,
        s.conversation_id,
        s.turn_index,
        s.status_code,
        s.status_message,
        s.tool_name
      FROM spans s
      LEFT JOIN span_attributes a
        ON a.span_id = s.span_id
        AND a.key = 'gen_ai.usage.cache_creation.input_tokens'
      WHERE s.operation_name = 'chat'
        AND s.start_time_ms >= ?
      ORDER BY s.start_time_ms ASC
    `;
    return db.all<Span>(sql, [timestampMs]);
  }

  async getRecentSessionSpans(limit: number): Promise<Map<string, Span[]>> {
    const db = await this.getDb();

    // First get the most recent session IDs
    const sessionsSql = `
      SELECT DISTINCT COALESCE(conversation_id, chat_session_id) AS session_id,
             MAX(start_time_ms) AS last_activity
      FROM spans
      WHERE operation_name = 'chat'
      GROUP BY COALESCE(conversation_id, chat_session_id)
      ORDER BY last_activity DESC
      LIMIT ?
    `;
    const sessions = await db.all<{ session_id: string; last_activity: number }>(
      sessionsSql,
      [limit]
    );

    const result = new Map<string, Span[]>();
    for (const { session_id } of sessions) {
      const spans = await this.getSpansForSession(session_id);
      result.set(session_id, spans);
    }
    return result;
  }

  dispose(): void {
    this.db?.close();
    this.db = null;
  }
}
