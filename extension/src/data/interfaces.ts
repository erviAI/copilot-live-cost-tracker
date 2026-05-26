import type { Span, SessionInfo } from '../domain/models.js';

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
 * Interface for accessing session metadata from session-store.db.
 */
export interface ISessionMetadataRepository {
  /** Get session metadata (summary, agent, cwd, timestamps) */
  getSessionMetadata(sessionId: string): Promise<SessionMetadata | null>;

  /** Get all session metadata for recent sessions */
  getRecentSessions(limit: number): Promise<SessionMetadata[]>;

  /** Check if the database is accessible */
  isAvailable(): Promise<boolean>;

  dispose(): void;
}

export interface SessionMetadata {
  id: string;
  summary: string | null;
  agentName: string | null;
  createdAt: number;
  updatedAt: number;
  cwd: string | null;
  repository: string | null;
  branch: string | null;
}

/**
 * Interface for resolving session display titles from state.vscdb.
 */
export interface ISessionTitleResolver {
  /** Resolve a session ID to its user-visible title */
  getTitle(sessionId: string): Promise<string | null>;

  /** Get all known session titles */
  getAllTitles(): Promise<Map<string, string>>;

  /** Invalidate any cached titles so they are re-fetched on next call */
  invalidateCache(): void;

  /** Check if the database is accessible */
  isAvailable(): Promise<boolean>;

  dispose(): void;
}
