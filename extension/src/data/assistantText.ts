/**
 * Copilot records assistant output as a JSON-encoded array of messages with
 * typed parts. The same shape appears in two places: the `attrs.response` field
 * of a debug-log `agent_response` event, and the `gen_ai.output.messages` span
 * attribute in agent-traces.db.
 */
export function extractAssistantText(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) return '';
  let messages: unknown;
  try { messages = JSON.parse(raw); } catch { return ''; }
  if (!Array.isArray(messages)) return '';
  const chunks: string[] = [];
  for (const msg of messages) {
    const parts = (msg as { parts?: unknown })?.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      const p = part as { type?: unknown; content?: unknown };
      if (p?.type === 'text' && typeof p.content === 'string' && p.content.length > 0) {
        chunks.push(p.content);
      }
    }
  }
  return chunks.join('\n\n').trim();
}
