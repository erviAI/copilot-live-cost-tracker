---
name: summarize-cli-session
description: 'Summarize a GitHub Copilot CLI (copilot-agent) session from its events.jsonl log: turns, modes, models, tool calls, user messages, errors, and duration. Use when: analyzing CLI sessions, auditing CLI tool usage, generating CLI session reports. NOTE: CLI logs do NOT include token counts — use the `summarize-session` skill for VS Code Copilot Chat sessions that need token/cost data.'
argument-hint: 'Session ID, or full path to events.jsonl'
---

# Summarize CLI Session

## Purpose

Analyze a GitHub Copilot **CLI** (`copilot-agent`) session and produce a structured summary:

- **Session metadata**: CLI version, repo, branch, cwd, duration
- **Conversation stats**: user messages, assistant turns, modes used, task completes
- **Models** used (from `session.model_change` events)
- **Tool calls** by name with counts and error totals
- **User messages** (first lines)

## CLI vs VS Code Logs

The Copilot CLI stores per-session state under:

```
%USERPROFILE%\.copilot\session-state\<sessionId>\events.jsonl
```

This is a **different schema** from VS Code Chat's `main.jsonl`:

| Field                 | VS Code (`main.jsonl`)        | CLI (`events.jsonl`)         |
|-----------------------|-------------------------------|------------------------------|
| Event records         | `llm_request`, `tool_call`, … | `assistant.turn_*`, `tool.execution_*`, `user.message`, … |
| Token counts          | Yes (`inputTokens`, `cachedTokens`, …) | **No**            |
| AIU usage             | Yes (`copilotUsageNanoAiu`)   | **No**                       |
| Tool names            | `attrs.toolName`              | `data.toolName`              |

Because CLI logs don't include token usage, this skill reports **structural** metrics only. For token/cache/AIU breakdowns, use the `summarize-session` skill on the corresponding VS Code session log.

## Data Source

```
%USERPROFILE%\.copilot\session-state\<sessionId>\events.jsonl
```

To list all CLI sessions on Windows:

```powershell
Get-ChildItem "$env:USERPROFILE\.copilot\session-state" -Directory |
  Select-Object Name, LastWriteTime
```

## Procedure

1. If the user provides a session ID, resolve it to `$env:USERPROFILE\.copilot\session-state\<sessionId>\events.jsonl`. Otherwise use the provided path.
2. Run the bundled script:
   ```powershell
   node .github/skills/summarize-cli-session/scripts/summarize-cli.js "<path-to-events.jsonl>"
   ```
3. Present the script output to the user as a markdown report.

## Output Sections

- **Session Overview** — CLI version, repo, branch, cwd, start/end, duration
- **Conversation** — user messages, assistant turns, modes used, task completes, model(s)
- **Tool Calls** — count per tool name + total + errors
- **User Messages** — first line of each (truncated)

## Notes

- `session.mode_changed` reveals when the user toggled `interactive` / `plan` / `autopilot`.
- `session.model_change` events list every model the session used.
- A `tool.execution_complete` with `success: false` counts as a tool error.
- Empty user messages are typically continuation prompts after notifications; they are reported as `(empty)`.

## Script

See [scripts/summarize-cli.js](./scripts/summarize-cli.js).
