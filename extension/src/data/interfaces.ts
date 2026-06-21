import type { Span } from '../domain/models.js';

/**
 * Interface for accessing token/span data from agent-traces.db.
 * Single Responsibility: only data retrieval, no cost calculation.
 */
export interface ISpanRepository {
  /** Get all LLM spans for a specific session */
  getSpansForSession(sessionId: string): Promise<Span[]>;

  /** Get all LLM spans since a given timestamp */
  getSpansSince(timestampMs: number): Promise<Span[]>;

  /** Get aggregated span data grouped by session, ordered by most recent */
  getRecentSessionSpans(limit: number): Promise<Map<string, Span[]>>;

  /** Check if the database is accessible */
  isAvailable(): Promise<boolean>;

  /** Clean up resources */
  dispose(): void;
}

/**
 * Optional capability for span sources that can resolve per-turn labels.
 * Kept separate from {@link ISpanRepository} so implementations that cannot
 * provide turn labels (e.g. the debug-logs fallback) are not forced to.
 */
export interface ITurnLabelProvider {
  /** Resolve trace-id → human-readable turn label for a session. */
  getTurnLabels(sessionId: string): Promise<Map<string, string>>;
}

/**
 * Interface for resolving session display titles from state.vscdb.
 */
export interface ISessionTitleResolver {
  /** Resolve a session ID to its user-visible title */
  getTitle(sessionId: string): Promise<string | null>;

  /** Get all known session titles */
  getAllTitles(): Promise<Map<string, string>>;

  /** Get workspace name for each session (sessionId → workspace folder name) */
  getAllWorkspaces(): Promise<Map<string, string>>;

  /** Invalidate any cached titles so they are re-fetched on next call */
  invalidateCache(): void;

  /** Check if the database is accessible */
  isAvailable(): Promise<boolean>;

  dispose(): void;
}
