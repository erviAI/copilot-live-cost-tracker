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
    // Also include subagent spans that share a trace_id with the session's spans
    // but have a tool-call ID (toolu_/call_) as their chat_session_id.
    const sql = SPAN_SELECT_SQL + `
      WHERE s.operation_name = 'chat'
        AND (
          s.chat_session_id = ? OR s.conversation_id = ?
          OR (
            (s.chat_session_id LIKE 'toolu_%' OR s.chat_session_id LIKE 'call_%')
            AND s.trace_id IN (
              SELECT s2.trace_id FROM spans s2
              WHERE s2.operation_name = 'chat'
                AND (s2.chat_session_id = ? OR s2.conversation_id = ?)
            )
          )
        )
      ORDER BY s.start_time_ms ASC
    `;
    const rows = await db.all<Span>(sql, [sessionId, sessionId, sessionId, sessionId]);
    return rows.map(normalizeTimestamps).filter(shouldIncludeChatSpan);
  }

  /**
   * Get user prompt labels for turns in a session.
   * Extracts the text from `copilot_chat.user_request` attribute on spans containing user prompts.
   * Returns a map of traceId → user prompt (first 50 chars).
   */
  async getTurnLabels(sessionId: string): Promise<Map<string, string>> {
    const db = await this.getDb();
    const sql = `
      SELECT s.trace_id, a.value
      FROM spans s
      JOIN span_attributes a ON a.span_id = s.span_id AND a.key = 'copilot_chat.user_request'
      WHERE s.operation_name = 'chat'
        AND (s.chat_session_id = ? OR s.conversation_id = ?)
        AND s.chat_session_id NOT LIKE 'toolu_%'
        AND s.chat_session_id NOT LIKE 'call_%'
        AND a.value LIKE '%<userRequest>%'
      ORDER BY s.start_time_ms ASC
    `;
    const rows = await db.all<{ trace_id: string; value: string }>(sql, [sessionId, sessionId]);
    const map = new Map<string, string>();
    for (const row of rows) {
      if (map.has(row.trace_id)) continue; // only first per trace
      const label = extractUserText(row.value);
      if (label) map.set(row.trace_id, label);
    }
    return map;
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
    const normalized = rows.map(normalizeTimestamps).filter(shouldIncludeChatSpan);
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
             AND s2.chat_session_id NOT LIKE 'call_%'
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

  /**
   * Get repository URL for each session from span_attributes.
   * Queries the 'github.copilot.git.repository' attribute and groups by chat_session_id.
   * Returns a Map of sessionId → repository short name (e.g. "erviAI/cost-research").
   */
  async getSessionRepositories(): Promise<Map<string, string>> {
    const db = await this.getDb();
    const sql = `
      SELECT
        COALESCE(sa_sess.value, s.chat_session_id) AS session_id,
        sa_repo.value AS repo_url
      FROM span_attributes sa_repo
      JOIN spans s ON s.span_id = sa_repo.span_id
      LEFT JOIN span_attributes sa_sess
        ON sa_sess.span_id = s.span_id
        AND sa_sess.key = 'copilot_chat.chat_session_id'
      WHERE sa_repo.key = 'github.copilot.git.repository'
        AND s.operation_name = 'chat'
      GROUP BY session_id
    `;
    const rows = await db.all<{ session_id: string; repo_url: string }>(sql, []);
    const map = new Map<string, string>();
    for (const row of rows) {
      if (!row.session_id || !row.repo_url) continue;
      map.set(row.session_id, repoUrlToShortName(row.repo_url));
    }
    return map;
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

/**
 * Copilot may emit a terminal canceled `chat` span after a request aborts.
 * Those rows have no response model and no token usage, but would otherwise
 * inflate the UI with a zero-cost phantom call for the request model.
 */
export function shouldIncludeChatSpan(span: Span): boolean {
  const statusMessage = span.statusMessage?.trim().toLowerCase() ?? '';
  const isCanceled = statusMessage.startsWith('cancel');
  const hasResponseModel = Boolean(span.responseModel);
  const hasUsage =
    span.inputTokens > 0 ||
    span.outputTokens > 0 ||
    span.cachedTokens > 0 ||
    span.cacheWriteTokens > 0;

  return !isCanceled || hasResponseModel || hasUsage;
}

const MAX_LABEL_LENGTH = 50;

/**
 * Extract user-visible text from `copilot_chat.user_request` JSON value.
 * Format is a JSON array of content blocks: [{"type":"text","text":"..."}]
 * The user's actual message is wrapped in <userRequest>...</userRequest> tags.
 */
function extractUserText(raw: string): string | null {
  try {
    const blocks = JSON.parse(raw);
    if (!Array.isArray(blocks)) return null;
    for (const block of blocks) {
      if (!block.text || typeof block.text !== 'string') continue;
      // Skip tool_result blocks
      if (block.type === 'tool_result') continue;
      // Extract text from <userRequest> tags
      const match = block.text.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/);
      if (match) {
        const text = match[1].trim();
        if (text.length === 0) continue;
        return text.length > MAX_LABEL_LENGTH ? text.slice(0, MAX_LABEL_LENGTH) + '…' : text;
      }
    }
  } catch { /* invalid JSON, skip */ }
  return null;
}

/**
 * Convert a git remote URL to a short "owner/repo" name.
 * Handles: https://github.com/owner/repo.git, git@github.com:owner/repo.git
 */
function repoUrlToShortName(url: string): string {
  // Strip trailing .git
  const cleaned = url.replace(/\.git$/, '');
  // HTTPS: https://github.com/owner/repo
  const httpsMatch = cleaned.match(/github\.com\/([^/]+\/[^/]+)$/);
  if (httpsMatch) return httpsMatch[1];
  // SSH: git@github.com:owner/repo
  const sshMatch = cleaned.match(/github\.com:([^/]+\/[^/]+)$/);
  if (sshMatch) return sshMatch[1];
  // Fallback: last two path segments
  const parts = cleaned.split('/').filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join('/') : cleaned;
}
