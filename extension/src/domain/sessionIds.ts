/**
 * A subagent (tool-call) span carries a synthetic `chatSessionId` that is the
 * tool-call id of the parent turn rather than a real chat session id. These ids
 * use provider-specific prefixes. Centralising the rule here keeps the TypeScript
 * checks in sync with the SQL `LIKE 'toolu_%' OR LIKE 'call_%'` filters used in
 * the repositories (which must mirror these prefixes).
 */
export const SUBAGENT_SESSION_ID_PREFIXES = ['toolu_', 'call_'] as const;

/** True when a chatSessionId actually denotes a subagent/tool-call, not a session. */
export function isSubagentSessionId(sessionId: string | null | undefined): boolean {
  if (!sessionId) return false;
  return SUBAGENT_SESSION_ID_PREFIXES.some((p) => sessionId.startsWith(p));
}
