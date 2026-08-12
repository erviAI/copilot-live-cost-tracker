import type { TurnOrigin } from './models.js';

/**
 * Copilot injects a synthetic turn when a background terminal command finishes:
 * `[Terminal <id> notification: command completed with exit code 1. Use send_to_terminal …]`
 * followed by the captured output. It gets its own turn index, trace and cost, so
 * without classification it looks exactly like a prompt the user typed.
 *
 * Anchored at the start so a user pasting such a log mid-message still counts as a
 * user prompt, and matching only the `[Terminal <id>` head so the 50-char truncated
 * span label (which cuts off mid-"notification") is still recognised.
 */
const TERMINAL_NOTIFICATION_RE = /^\s*\[Terminal\s+[\w-]{6,}/i;

/** Status sentence inside the notification header, e.g. "command completed with exit code 1". */
const TERMINAL_STATUS_RE = /notification:\s*([^.\]]+)/i;

/** Exit code embedded in the status sentence. */
const EXIT_CODE_RE = /exit code\s+(-?\d+)/i;

export interface TurnOriginInput {
  /** Label from agent-traces.db, keyed by trace id. */
  label?: string | null;
  /** Full user message from session-store.db, keyed by turn index. */
  promptText?: string | null;
  /** True for spans emitted by a subagent invocation rather than the session itself. */
  isSubagent?: boolean;
}

/**
 * Classify where a turn came from: the user, an automatic continuation, or a subagent.
 * The label wins over the session-store text because it is keyed by trace id, which
 * cannot drift out of alignment with the spans the way turn indexes can.
 */
export function classifyTurnOrigin({ label, promptText, isSubagent }: TurnOriginInput): TurnOrigin {
  if (isSubagent) return 'subagent';
  const text = label ?? promptText;
  if (!text) return 'unknown';
  if (TERMINAL_NOTIFICATION_RE.test(text)) return 'auto-terminal';
  return 'user';
}

/**
 * Readable label for an automatic turn, replacing the raw notification text
 * (which starts with a terminal UUID and is useless once truncated).
 */
export function autoTurnLabel(origin: TurnOrigin, text: string | null | undefined): string | null {
  if (origin !== 'auto-terminal') return null;
  const status = text?.match(TERMINAL_STATUS_RE)?.[1]?.trim();
  if (!status) return 'Terminal follow-up';
  const exitCode = status.match(EXIT_CODE_RE)?.[1];
  if (exitCode) return `Terminal follow-up · command completed (exit ${exitCode})`;
  return `Terminal follow-up · ${status}`;
}
