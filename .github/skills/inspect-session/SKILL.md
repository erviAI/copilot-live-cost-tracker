---
name: inspect-session
description: 'Detailed report on a GitHub Copilot Chat session by joining `agent-traces.db` (spans/tokens/tools) with `session-store.db` (turns/files/checkpoints) and `debug-logs` (user messages). Use when: drilling into a single session, comparing model usage, listing tracked files, viewing user messages, debugging tool errors. If no session id is provided, lists the 5 most recent sessions with names.'
argument-hint: 'Optional: session id. Omit to list 5 most recent sessions.'
---

# Inspect Session

## Purpose

Combine the structured Copilot data sources into one report for a single VS Code Chat session:

| Source | Provides |
|--------|----------|
| `agent-traces.db` (spans) | per-model LLM stats (calls, input/output/cached tokens, TTFT, duration), tool call counts, errors |
| `session-store.db` (turns, files, refs, checkpoints) | user messages, tracked files, references, checkpoints, repo/cwd/branch |
| `debug-logs/<session-id>/main.jsonl` | first user message (fallback for session name) |

See [`docs/copilot-data-sources.md`](../../../docs/copilot-data-sources.md) for the full data-source map.

## When to use

- "Show me details about session `<id>`."
- "What did I do in this session?"
- "Which tools/files were used and how many tokens?"
- "Show recent Copilot sessions."

If the user provides no session id, the skill shows the 5 most recent sessions (id, **name**, model, duration, llm/tool calls, tokens) so they can pick one.

## Procedure

1. Resolve the session id from the user's request, if any.
2. Run the bundled script:
   ```powershell
   node tools/agent-traces/inspect-session.js [<sessionId>]
   ```
3. Forward the markdown output to the user.

Optional flags:
- `--traces <path>` override `agent-traces.db` location
- `--store <path>` override `session-store.db` location

## Output sections

### 5 Latest Sessions (no session id)

Table with: `session_id`, `name`, `started`, `dur_min`, `model`, `llm_calls`, `tool_calls`, `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`

Session names are resolved in order:
1. `session-store.db` → `sessions.summary`
2. `session-store.db` → `turns.user_message` (turn 0)
3. `debug-logs/<session-id>/main.jsonl` → first `user_message` event

### Detailed Report (with session id)

- **Overview** — agent, start/end, duration, span count, repo/cwd/branch (when known)
- **LLM Calls by Model** — calls, input/output/cached tokens, avg TTFT, avg duration + totals + cache-hit %
- **Tool Calls** — per-tool counts and OTel-status-2 error counts
- **Errors** — `status_code = 2` spans with their `status_message`
- **Turns** — count + first 200 chars of each user message (from `session-store.db`)
- **Tracked Files** (top 20) — `file_path`, `tool_name`, touches
- **References** — `ref_type` counts
- **Checkpoints** — number, title, created_at

## Notes

- Uses `better-sqlite3` which properly handles WAL mode — no need to close VS Code for fresh data.
- Spans use OpenTelemetry status: `1`=OK, `2`=ERROR, `0`=UNSET. The script counts errors only when `status_code = 2`.
- `chat_session_id` and `conversation_id` are queried together (`OR`) because they sometimes diverge for the same logical session.
- Token totals here will match the `summarize-session` skill (which reads `main.jsonl`) when both sources are available.

## Script

See [`tools/agent-traces/inspect-session.js`](../../../tools/agent-traces/inspect-session.js).

Requires `better-sqlite3` (already installed in `tools/agent-traces/node_modules`). To reinstall:

```powershell
pushd tools/agent-traces; npm install better-sqlite3; popd
```
