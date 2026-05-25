#!/usr/bin/env node
/**
 * Summarize a Copilot CLI session from events.jsonl
 * Usage: node summarize-cli.js <path-to-events.jsonl>
 *
 * CLI logs (~/.copilot/session-state/<id>/events.jsonl) do NOT include
 * token counts. This script reports structural metrics only.
 */

const fs = require('fs');
const path = require('path');

const logPath = process.argv[2];
if (!logPath) {
  console.error('Usage: node summarize-cli.js <path-to-events.jsonl>');
  process.exit(1);
}

const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
const events = lines
  .map(l => {
    try { return JSON.parse(l); } catch { return null; }
  })
  .filter(Boolean);

const sessionId = path.basename(path.dirname(logPath));

const byType = type => events.filter(e => e.type === type);
const start = byType('session.start')[0];
const userMsgs = byType('user.message');
const turns = byType('assistant.turn_start');
const modeChanges = byType('session.mode_changed');
const modelChanges = byType('session.model_change');
const taskCompletes = byType('session.task_complete');
const toolStarts = byType('tool.execution_start');
const toolCompletes = byType('tool.execution_complete');
const toolErrors = toolCompletes.filter(e => e.data && e.data.success === false);

const firstTs = events[0]?.timestamp ? new Date(events[0].timestamp) : null;
const lastTs = events[events.length - 1]?.timestamp ? new Date(events[events.length - 1].timestamp) : null;
const durMin = firstTs && lastTs ? Math.round((lastTs - firstTs) / 60000) : null;

const modes = [...new Set(modeChanges.map(e => e.data?.newMode).filter(Boolean))];
const models = [...new Set(modelChanges.map(e => e.data?.newModel).filter(Boolean))];

// Tool counts
const toolCounts = {};
for (const e of toolStarts) {
  const name = e.data?.toolName || '(unknown)';
  toolCounts[name] = (toolCounts[name] || 0) + 1;
}
const toolRows = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]);

console.log(`# CLI Session Summary: ${sessionId}\n`);

console.log('## Session Overview\n');
if (start?.data) {
  console.log(`- **Copilot CLI:** ${start.data.copilotVersion || 'unknown'} (\`${start.data.producer || 'unknown'}\`)`);
  if (start.data.context) {
    const c = start.data.context;
    if (c.repository) console.log(`- **Repo:** ${c.repository}${c.branch ? ` · **Branch:** ${c.branch}` : ''}`);
    if (c.cwd) console.log(`- **CWD:** \`${c.cwd}\``);
  }
}
if (firstTs) console.log(`- **Start:** ${firstTs.toISOString()}`);
if (lastTs)  console.log(`- **End:**   ${lastTs.toISOString()}`);
if (durMin !== null) console.log(`- **Duration:** ~${durMin} min`);
console.log('');

console.log('## Conversation\n');
console.log(`- **User messages:** ${userMsgs.length}`);
console.log(`- **Assistant turns:** ${turns.length}`);
console.log(`- **Task completes:** ${taskCompletes.length}`);
if (modes.length)  console.log(`- **Modes used:** ${modes.join(', ')}`);
if (models.length) console.log(`- **Model(s):** ${models.join(', ')}`);
console.log('');

console.log('## Tool Calls\n');
if (toolRows.length === 0) {
  console.log('_No tool calls recorded._\n');
} else {
  console.log('| Tool | Count |');
  console.log('|------|------:|');
  for (const [name, count] of toolRows) {
    console.log(`| ${name} | ${count} |`);
  }
  console.log('');
  console.log(`**Total:** ${toolStarts.length} calls, ${toolErrors.length} errors\n`);
}

if (toolErrors.length) {
  console.log('## Errors\n');
  for (const e of toolErrors) {
    const name = toolStarts.find(s => s.data?.toolCallId === e.data?.toolCallId)?.data?.toolName || 'unknown';
    const msg = (e.data?.result?.content || JSON.stringify(e.data?.result || {})).toString().replace(/\s+/g, ' ').slice(0, 200);
    console.log(`- **${name}**: ${msg}`);
  }
  console.log('');
}

console.log('## User Messages\n');
if (userMsgs.length === 0) {
  console.log('_None._');
} else {
  userMsgs.forEach((m, i) => {
    const raw = (m.data?.content || '').replace(/\s+/g, ' ').trim();
    const text = raw ? (raw.length > 140 ? raw.slice(0, 140) + '…' : raw) : '_(empty)_';
    console.log(`${i + 1}. ${text}`);
  });
}

console.log('\n> Note: Copilot CLI `events.jsonl` does **not** record token counts, cache info, or AIU usage.');
