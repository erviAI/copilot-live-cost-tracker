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
];

const ignoredSet = new Set(IGNORED_AGENT_NAMES.map(n => n.toLowerCase()));

/** Returns true if the span's agent should be excluded from session detection/listing. */
export function isIgnoredAgent(span: Span): boolean {
  if (!span.agentName) return false;
  return ignoredSet.has(span.agentName.toLowerCase());
}
