---
name: summarize-session
description: 'Summarize Copilot session usage: LLM calls grouped by model, input/output tokens, cache read/write info, tool calls, errors, and duration. Use when: analyzing session costs, reviewing token usage, auditing API calls, generating usage reports, breaking down per-model token spend.'
argument-hint: 'Optional: path to main.jsonl (defaults to current session)'
---

# Summarize Session

## Purpose

Analyze a Copilot Chat session debug log (`main.jsonl`) and produce a structured usage summary:

- **LLM calls broken down per model** (sessions can use multiple models — e.g. main model + title/categorization helpers)
- **Token usage** per model: input, output, cache reads, cache misses, hit %
- **Tool calls** by name with counts and error totals
- **Session metadata**: versions, duration, turns, subagents
- **Copilot AIU usage** (`copilotUsageNanoAiu`) when present

## Cache Read vs Cache Write

Copilot's `main.jsonl` only records `cachedTokens`, which represents **cache reads** (tokens served from prompt cache).

- **Cache read** = `attrs.cachedTokens` on the `llm_request` event
- **Cache miss** = `inputTokens - cachedTokens` (fresh tokens billed at full input rate)
- **Cache write** = NOT logged separately. On providers like Anthropic, cache writes happen implicitly when a new prefix is sent; the log does not expose `cache_creation_input_tokens`.

The script reports cache reads and misses per model. Cache writes cannot be derived from the log.

## Data Source

```
<userStorage>/GitHub.copilot-chat/debug-logs/<sessionId>/main.jsonl
```

Current session: `{{VSCODE_TARGET_SESSION_LOG}}`

To list all sessions on Windows:
```powershell
Get-ChildItem "$env:APPDATA\Code\User\workspaceStorage\*\GitHub.copilot-chat\debug-logs" -Recurse -Directory
```

## Procedure

1. Determine the `main.jsonl` path (current session unless user provides one).
2. Run the bundled script:
   ```powershell
   node .github/skills/summarize-session/scripts/summarize.js "<path-to-main.jsonl>"
   ```
3. Present the script output to the user as a markdown report.

## Output Sections

- **Session Overview** — Copilot/VS Code version, user messages, turns, subagent count, duration
- **LLM Calls by Model** — table with calls, input, output, cache read, cache miss, hit %, avg TTFT, avg duration
- **Token Totals** — aggregate across all models + AIU usage
- **Tool Calls** — count per tool name + total + errors
- **Errors** — any events with `status: "error"`

## Notes

- The script groups by `attrs.model`, so multi-model sessions (e.g. main `claude-opus-4.5` + `gpt-4o-mini` for title generation in `title-*.jsonl` files) appear as separate rows when present in `main.jsonl`.
- Title/categorization/summarization helpers are usually in sibling `*.jsonl` files; pass those paths separately to get their per-model stats.
- Subagent LLM calls live in `runSubagent-*.jsonl` — run the script on those files individually for nested breakdowns.

## Script

See [scripts/summarize.js](./scripts/summarize.js).
