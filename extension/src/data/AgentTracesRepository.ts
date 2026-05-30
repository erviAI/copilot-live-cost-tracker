import * as path from 'path';
import type { ISpanRepository } from './interfaces.js';
import type { Span } from '../domain/models.js';
import { openDatabase, type Database } from './sqlite.js';

const AGENT_TRACES_RELATIVE = 'Code/User/globalStorage/github.copilot-chat/agent-traces.db';

/** Shared SELECT clause that aliases snake_case DB columns to camelCase Span fields */
const SPAN_SELECT_SQL = `
  SELECT
    s.span_id AS spanId,
    s.trace_id AS traceId,
    s.parent_span_id AS parentSpanId,
    s.operation_name AS operationName,
    s.agent_name AS agentName,
    s.request_model AS requestModel,
    s.response_model AS responseModel,
    s.input_tokens AS inputTokens,
    s.output_tokens AS outputTokens,
    s.cached_tokens AS cachedTokens,
    CAST(COALESCE(a.value, '0') AS INTEGER) AS cacheWriteTokens,
    COALESCE(s.reasoning_tokens, 0) AS reasoningTokens,
    s.start_time_ms AS startTimeMs,
    s.end_time_ms AS endTimeMs,
    s.ttft_ms AS ttftMs,
    s.chat_session_id AS chatSessionId,
    s.conversation_id AS conversationId,
    s.turn_index AS turnIndex,
    s.status_code AS statusCode,
    s.status_message AS statusMessage,
    s.tool_name AS toolName
  FROM spans s
  LEFT JOIN span_attributes a
    ON a.span_id = s.span_id
    AND a.key = 'gen_ai.usage.cache_creation.input_tokens'
`;

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
    const sql = SPAN_SELECT_SQL + `
      WHERE s.operation_name = 'chat'
        AND (s.chat_session_id = ? OR s.conversation_id = ?)
      ORDER BY s.start_time_ms ASC
    `;
    const rows = await db.all<Span>(sql, [sessionId, sessionId]);
    return rows.map(normalizeTimestamps);
  }

  async getSpansSince(timestampMs: number): Promise<Span[]> {
    const db = await this.getDb();
    const sql = SPAN_SELECT_SQL + `
      WHERE s.operation_name = 'chat'
        AND s.start_time_ms >= ?
      ORDER BY s.start_time_ms ASC
    `;
    // Query with a wide lower bound so we still match rows even if the DB
    // stores microseconds. Normalization happens in JS below.
    const rawBound = Math.min(timestampMs, Math.floor(timestampMs / 1000));
    const rows = await db.all<Span>(sql, [rawBound]);
    const normalized = rows.map(normalizeTimestamps);
    // Final filter in ms-space after normalization.
    return normalized.filter(s => s.startTimeMs >= timestampMs);
  }

  async getRecentSessionSpans(limit: number): Promise<Map<string, Span[]>> {
    const db = await this.getDb();

    // First get the most recent session IDs.
    // Resolve subagent spans (chat_session_id LIKE 'toolu_%') to their parent session
    // via trace_id: all spans in a turn share trace_id, and the parent session's spans
    // have the real UUID as chat_session_id.
    const sessionsSql = `
      SELECT DISTINCT
        COALESCE(
          (SELECT s2.chat_session_id FROM spans s2
           WHERE s2.trace_id = s.trace_id
             AND s2.chat_session_id NOT LIKE 'toolu_%'
             AND s2.operation_name = 'chat'
           LIMIT 1),
          s.chat_session_id,
          s.conversation_id
        ) AS session_id,
        MAX(s.start_time_ms) AS last_activity
      FROM spans s
      WHERE s.operation_name = 'chat'
      GROUP BY session_id
      HAVING session_id IS NOT NULL
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

/**
 * Defensive timestamp normalization.
 *
 * Copilot's agent-traces.db column is documented as epoch-ms, but some
 * builds emit microseconds. Detect by magnitude: anything more than ~100x
 * current epoch-ms is treated as microseconds and divided by 1000.
 */
function normalizeTimestamps(span: Span): Span {
  const nowMs = Date.now();
  const threshold = nowMs * 100;
  if (span.startTimeMs > threshold || span.endTimeMs > threshold) {
    return {
      ...span,
      startTimeMs: Math.floor(span.startTimeMs / 1000),
      endTimeMs: Math.floor(span.endTimeMs / 1000),
    };
  }
  return span;
}
