/**
 * Validation for session/conversation identifiers that are interpolated into
 * filesystem paths. Session IDs originate from the database or, ultimately, the
 * webview, so they are treated as untrusted input. Restricting them to a safe
 * character set prevents path-traversal (e.g. `..\..\secret`) when they are
 * joined into `debug-logs/<sessionId>/main.jsonl`.
 */

/** Matches the identifiers Copilot emits (UUIDs, `toolu_…`, `call_…`, etc.). */
const SAFE_SESSION_ID = /^[A-Za-z0-9_.-]{1,128}$/;

/** True when the id is safe to interpolate into a filesystem path. */
export function isSafeSessionId(sessionId: string): boolean {
  // Reject path separators and parent-directory segments explicitly, then
  // require the whole string to match the conservative allow-list.
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..')) {
    return false;
  }
  return SAFE_SESSION_ID.test(sessionId);
}
