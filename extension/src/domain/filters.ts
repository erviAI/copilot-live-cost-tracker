import type { Span } from './models.js';

/**
 * Agent names that should NOT be treated as user-facing chat sessions.
 *
 * These typically belong to internal Copilot utilities (inline completions,
 * language-model wrappers used by other extensions, background helpers, etc.)
 * rather than an interactive chat the user is actively working in.
 *
 * Add more entries here to exclude additional internal agents.
 * Matching is case-insensitive on the exact agent name.
 */
export const IGNORED_AGENT_NAMES: ReadonlyArray<string> = [
  'copilotLanguageModelWrapper',
  'gitCommitMessageGenerator',
];

const ignoredSet = new Set(IGNORED_AGENT_NAMES.map(n => n.toLowerCase()));

/** Returns true if the span's agent should be excluded from session detection/listing. */
export function isIgnoredAgent(span: Span): boolean {
  if (!span.agentName) return false;
  return ignoredSet.has(span.agentName.toLowerCase());
}

/**
 * Agent name fragment identifying a conversation-compaction call — the model
 * request Copilot issues for `/compact` (and automatically when a conversation
 * outgrows the context window).
 */
export const COMPACTION_AGENT_MARKER = 'summarizeconversationhistory';

/**
 * Returns true if the span is a conversation-compaction call.
 *
 * Matched as a substring rather than an exact name: the agent appears both as
 * `summarizeConversationHistory` and `summarizeConversationHistory-full`, and
 * Copilot prefixes retried requests (`retry-error-…`, `retry-server-error-…`).
 */
export function isCompactionAgent(span: Span): boolean {
  if (!span.agentName) return false;
  return span.agentName.toLowerCase().includes(COMPACTION_AGENT_MARKER);
}
