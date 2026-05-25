#!/usr/bin/env node
/**
 * Detailed Copilot session inspector.
 *
 * - With no argument: prints the 5 most recent sessions from agent-traces.db.
 * - With a session id: prints a combined report joining:
 *     - agent-traces.db (spans):     per-model LLM stats, tool calls, errors, duration
 *     - session-store.db (turns):    user messages, tracked files, checkpoints
 *
 * Usage:
 *   node tools/agent-traces/inspect-session.js                 # latest 5
 *   node tools/agent-traces/inspect-session.js <sessionId>     # detailed report
 *   node tools/agent-traces/inspect-session.js --traces <path> --store <path> [<sessionId>]
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Database = require('better-sqlite3');

function parseArgs(argv) {
  const args = { traces: null, store: null, sessionId: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--traces') args.traces = argv[++i];
    else if (argv[i] === '--store') args.store = argv[++i];
    else if (!args.sessionId) args.sessionId = argv[i];
  }
  const base = path.join(process.env.APPDATA || '', 'Code', 'User', 'globalStorage', 'github.copilot-chat');
  if (!args.traces) args.traces = path.join(base, 'agent-traces.db');
  if (!args.store)  args.store  = path.join(base, 'session-store.db');
  return args;
}

function openDb(p) {
  if (!fs.existsSync(p)) return null;
  return new Database(p, { readonly: true });
}

function fmt(n) {
  return n == null ? '' : Number(n).toLocaleString('en-US');
}

function isoMs(ms) {
  return ms ? new Date(Number(ms)).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '';
}

function hasTable(db, name) {
  try {
    const r = db.prepare(`SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?`).get(name);
    return !!r;
  } catch { return false; }
}

function table(headers, data) {
  console.log('| ' + headers.join(' | ') + ' |');
  console.log('|' + headers.map(h => h.endsWith('?') ? '---' : (typeof data[0]?.[h] === 'number' ? '---:' : '---')).join('|') + '|');
  for (const r of data) {
    console.log('| ' + headers.map(h => {
      const v = r[h];
      if (v == null) return '';
      if (typeof v === 'number') return fmt(v);
      const s = String(v).replace(/\r?\n/g, ' ');
      return s.length > 200 ? s.slice(0, 200) + '…' : s;
    }).join(' | ') + ' |');
  }
}

/**
 * Scan debug-logs for first user_message of each session.
 * Structure: workspaceStorage/<hash>/GitHub.copilot-chat/debug-logs/<session-id>/main.jsonl
 * @param {string[]} sessionIds - session IDs to look for
 * @returns {Object} map of session_id -> first user message content
 */
function getFirstUserMessagesFromDebugLogs(sessionIds) {
  const result = {};
  const needed = new Set(sessionIds);
  if (needed.size === 0) return result;

  const wsBase = path.join(process.env.APPDATA || '', 'Code', 'User', 'workspaceStorage');
  if (!fs.existsSync(wsBase)) return result;

  // Scan all workspaceStorage folders
  for (const wsDir of fs.readdirSync(wsBase)) {
    const debugLogsPath = path.join(wsBase, wsDir, 'GitHub.copilot-chat', 'debug-logs');
    if (!fs.existsSync(debugLogsPath)) continue;

    for (const sessionDir of fs.readdirSync(debugLogsPath)) {
      if (!needed.has(sessionDir)) continue; // Skip if not in our list

      const mainJsonl = path.join(debugLogsPath, sessionDir, 'main.jsonl');
      if (!fs.existsSync(mainJsonl)) continue;

      // Read line by line until we find first user_message
      try {
        const content = fs.readFileSync(mainJsonl, 'utf8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'user_message' && event.attrs?.content) {
              const msg = event.attrs.content.replace(/\r?\n/g, ' ').trim();
              result[sessionDir] = msg.length > 60 ? msg.slice(0, 57) + '…' : msg;
              needed.delete(sessionDir);
              break;
            }
          } catch {}
        }
      } catch {}

      if (needed.size === 0) return result; // Found all
    }
  }

  return result;
}

function main() {
  const { traces, store, sessionId } = parseArgs(process.argv.slice(2));

  const tdb = openDb(traces);
  if (!tdb) { console.error('agent-traces.db not found:', traces); process.exit(1); }
  const sdb = openDb(store);

  if (!sessionId) {
    console.log('# 5 Latest Sessions\n');
    console.log(`_Source: ${traces}_\n`);
    const r = tdb.prepare(`
      SELECT
        chat_session_id AS session_id,
        MIN(start_time_ms) AS started,
        MAX(end_time_ms)   AS ended,
        ROUND((MAX(end_time_ms)-MIN(start_time_ms))/60000.0, 1) AS dur_min,
        (SELECT response_model FROM spans s2 WHERE s2.chat_session_id = s.chat_session_id AND s2.operation_name='chat' ORDER BY start_time_ms DESC LIMIT 1) AS model,
        SUM(operation_name='chat') AS llm_calls,
        SUM(operation_name='execute_tool') AS tool_calls,
        SUM(CASE WHEN operation_name='chat' THEN input_tokens  ELSE 0 END) AS input_tokens,
        SUM(CASE WHEN operation_name='chat' THEN output_tokens ELSE 0 END) AS output_tokens,
        SUM(CASE WHEN operation_name='chat' THEN cached_tokens ELSE 0 END) AS cache_read_tokens,
        (SELECT COALESCE(SUM(CAST(a.value AS INTEGER)), 0)
           FROM span_attributes a
           JOIN spans s3 ON s3.span_id = a.span_id
          WHERE a.key = 'gen_ai.usage.cache_creation.input_tokens'
            AND s3.chat_session_id = s.chat_session_id) AS cache_write_tokens
      FROM spans s
      WHERE chat_session_id IS NOT NULL
      GROUP BY chat_session_id
      ORDER BY started DESC
      LIMIT 5
    `).all();
    if (r.length === 0) { console.log('_No sessions found._'); return; }

    // Look up session names from session-store.db if available
    // Use summary first, fall back to first user message
    const summaryMap = {};
    if (sdb && hasTable(sdb, 'sessions')) {
      const ids = r.map(x => x.session_id);
      const placeholders = ids.map(() => '?').join(',');
      const summaryRows = sdb.prepare(`SELECT id, summary FROM sessions WHERE id IN (${placeholders})`).all(...ids);
      for (const row of summaryRows) {
        summaryMap[row.id] = row.summary;
      }
      // Fall back to first user message for sessions without a summary
      if (hasTable(sdb, 'turns')) {
        const missingIds = ids.filter(id => !summaryMap[id]);
        if (missingIds.length > 0) {
          const mp = missingIds.map(() => '?').join(',');
          const turnRows = sdb.prepare(`
            SELECT session_id, user_message 
            FROM turns 
            WHERE session_id IN (${mp}) AND turn_index = 0
          `).all(...missingIds);
          for (const row of turnRows) {
            if (!summaryMap[row.session_id] && row.user_message) {
              // Truncate to 60 chars for readability
              const msg = row.user_message.replace(/\r?\n/g, ' ').trim();
              summaryMap[row.session_id] = msg.length > 60 ? msg.slice(0, 57) + '…' : msg;
            }
          }
        }
      }
    }

    // Final fallback: scan debug-logs for first user_message
    const ids = r.map(x => x.session_id);
    const stillMissing = ids.filter(id => !summaryMap[id]);
    if (stillMissing.length > 0) {
      const fromDebugLogs = getFirstUserMessagesFromDebugLogs(stillMissing);
      for (const [id, msg] of Object.entries(fromDebugLogs)) {
        summaryMap[id] = msg;
      }
    }

    table(
      ['session_id', 'name', 'started', 'dur_min', 'model', 'llm_calls', 'tool_calls', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'],
      r.map(x => ({ ...x, name: summaryMap[x.session_id] || '', started: isoMs(x.started) }))
    );
    console.log('\nRun again with a `session_id` from the table above for a detailed report.');
    return;
  }

  // Detailed report
  const sid = sessionId;

  const overview = tdb.prepare(`
    SELECT
      MIN(start_time_ms) AS started,
      MAX(end_time_ms)   AS ended,
      ROUND((MAX(end_time_ms)-MIN(start_time_ms))/60000.0, 1) AS dur_min,
      MAX(agent_name) AS agent_name,
      COUNT(*) AS span_count
    FROM spans WHERE chat_session_id = ? OR conversation_id = ?
  `).get(sid, sid);

  if (!overview || !overview.span_count) {
    console.log(`# Session ${sid}\n\n_No spans found in agent-traces.db._`);
    return;
  }

  console.log(`# Session ${sid}\n`);
  console.log('## Overview\n');
  console.log(`- **Agent:** ${overview.agent_name || 'unknown'}`);
  console.log(`- **Started:** ${isoMs(overview.started)}`);
  console.log(`- **Ended:**   ${isoMs(overview.ended)}`);
  console.log(`- **Duration:** ${overview.dur_min} min`);
  console.log(`- **Span count:** ${overview.span_count}`);

  // session-store.db extras
  let storeSession = null;
  const storeAvailable = sdb && hasTable(sdb, 'sessions') && hasTable(sdb, 'turns');
  if (sdb && !storeAvailable) {
    console.error('Note: session-store.db schema not visible (likely all in WAL). Conversation/files/checkpoints sections skipped.');
  }
  if (storeAvailable) {
    storeSession = sdb.prepare(`SELECT cwd, repository, host_type, branch, summary, agent_name, created_at, updated_at FROM sessions WHERE id = ?`).get(sid);
    if (storeSession) {
      if (storeSession.repository) console.log(`- **Repo:** ${storeSession.repository}${storeSession.branch ? ` · **Branch:** ${storeSession.branch}` : ''}`);
      if (storeSession.cwd) console.log(`- **CWD:** \`${storeSession.cwd}\``);
      if (storeSession.host_type) console.log(`- **Host:** ${storeSession.host_type}`);
    }
  }
  console.log('');

  // Per-model LLM stats
  console.log('## LLM Calls by Model\n');
  const byModel = tdb.prepare(`
    SELECT
      COALESCE(s.response_model, s.request_model, '(unknown)') AS model,
      COUNT(*) AS calls,
      SUM(s.input_tokens)  AS input,
      SUM(s.output_tokens) AS output,
      SUM(s.cached_tokens) AS cache_read,
      SUM(CAST(COALESCE(a.value, '0') AS INTEGER)) AS cache_write,
      ROUND(AVG(s.ttft_ms)) AS avg_ttft_ms,
      ROUND(AVG(s.end_time_ms - s.start_time_ms)) AS avg_dur_ms
    FROM spans s
    LEFT JOIN span_attributes a
      ON a.span_id = s.span_id
     AND a.key = 'gen_ai.usage.cache_creation.input_tokens'
    WHERE s.operation_name = 'chat' AND (s.chat_session_id = ? OR s.conversation_id = ?)
    GROUP BY model
    ORDER BY calls DESC
  `).all(sid, sid);
  if (byModel.length === 0) {
    console.log('_No chat spans._');
  } else {
    table(['model', 'calls', 'input', 'output', 'cache_read', 'cache_write', 'avg_ttft_ms', 'avg_dur_ms'], byModel);
    const tot = byModel.reduce((a, r) => ({
      calls: a.calls + r.calls,
      input: a.input + (r.input || 0),
      output: a.output + (r.output || 0),
      cache_read: a.cache_read + (r.cache_read || 0),
      cache_write: a.cache_write + (r.cache_write || 0),
    }), { calls: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 });
    const hit = tot.input ? Math.round(100 * tot.cache_read / tot.input) : 0;
    console.log(`\n**Totals:** ${fmt(tot.calls)} calls · input ${fmt(tot.input)} · output ${fmt(tot.output)} · cache read ${fmt(tot.cache_read)} (${hit}%) · cache write ${fmt(tot.cache_write)}`);
  }
  console.log('');

  // Tool calls
  console.log('## Tool Calls\n');
  const byTool = tdb.prepare(`
    SELECT
      COALESCE(tool_name, '(unknown)') AS tool_name,
      COUNT(*) AS calls,
      SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS errors
    FROM spans
    WHERE operation_name = 'execute_tool' AND (chat_session_id = ? OR conversation_id = ?)
    GROUP BY tool_name
    ORDER BY calls DESC
  `).all(sid, sid);
  if (byTool.length === 0) {
    console.log('_No tool spans._');
  } else {
    table(['tool_name', 'calls', 'errors'], byTool);
    const totCalls = byTool.reduce((s, r) => s + r.calls, 0);
    const totErr = byTool.reduce((s, r) => s + (r.errors || 0), 0);
    console.log(`\n**Total:** ${fmt(totCalls)} calls · ${fmt(totErr)} errors`);
  }
  console.log('');

  // Errors detail
  const errs = tdb.prepare(`
    SELECT operation_name, tool_name, status_message
    FROM spans
    WHERE status_code = 2 AND (chat_session_id = ? OR conversation_id = ?)
    ORDER BY start_time_ms
  `).all(sid, sid);
  if (errs.length) {
    console.log('## Errors\n');
    for (const e of errs) {
      console.log(`- **${e.operation_name}${e.tool_name ? '/' + e.tool_name : ''}:** ${e.status_message || '(no message)'}`);
    }
    console.log('');
  }

  // Conversation from session-store.db
  if (storeAvailable) {
    const turns = sdb.prepare(`SELECT turn_index, user_message, length(assistant_response) AS resp_len, timestamp FROM turns WHERE session_id = ? ORDER BY turn_index`).all(sid);
    if (turns.length) {
      console.log('## Turns (from session-store.db)\n');
      const userTurns = turns.filter(t => t.user_message && t.user_message.trim());
      console.log(`- Total turns: **${turns.length}** · user-initiated: **${userTurns.length}**`);
      console.log('');
      console.log('### User messages');
      userTurns.forEach((t, i) => {
        const msg = t.user_message.replace(/\s+/g, ' ').trim();
        console.log(`${i + 1}. _(turn ${t.turn_index})_ ${msg.length > 200 ? msg.slice(0, 200) + '…' : msg}`);
      });
      console.log('');
    }

    const files = sdb.prepare(`SELECT file_path, tool_name, COUNT(*) AS touches FROM session_files WHERE session_id = ? GROUP BY file_path ORDER BY touches DESC LIMIT 20`).all(sid);
    if (files.length) {
      console.log('## Tracked Files (top 20)\n');
      table(['file_path', 'tool_name', 'touches'], files);
      console.log('');
    }

    const refs = sdb.prepare(`SELECT ref_type, COUNT(*) AS n FROM session_refs WHERE session_id = ? GROUP BY ref_type ORDER BY n DESC`).all(sid);
    if (refs.length) {
      console.log('## References\n');
      table(['ref_type', 'n'], refs);
      console.log('');
    }

    const cps = sdb.prepare(`SELECT checkpoint_number, title, created_at FROM checkpoints WHERE session_id = ? ORDER BY checkpoint_number`).all(sid);
    if (cps.length) {
      console.log('## Checkpoints\n');
      table(['checkpoint_number', 'title', 'created_at'], cps);
      console.log('');
    }
  } else {
    console.log('_session-store.db not available or schema not visible — conversation/files/checkpoints omitted._\n');
  }

  tdb.close();
  if (sdb) sdb.close();
}

main();
