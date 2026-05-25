#!/usr/bin/env node
/**
 * Summarize Copilot session from main.jsonl
 * Usage: node summarize.js <path-to-main.jsonl>
 */

const fs = require('fs');
const path = require('path');

const logPath = process.argv[2];
if (!logPath) {
  console.error('Usage: node summarize.js <path-to-main.jsonl>');
  process.exit(1);
}

const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
const events = lines.map(l => {
  try { return JSON.parse(l); }
  catch { return null; }
}).filter(Boolean);

const sessionId = path.basename(path.dirname(logPath));
const fmt = n => n.toLocaleString('en-US');

// Session overview
const start = events.find(e => e.type === 'session_start');
const userMsgs = events.filter(e => e.type === 'user_message');
const turns = events.filter(e => e.type === 'turn_end');
const subagents = events.filter(e => e.type === 'subagent');

console.log(`# Session Summary: ${sessionId}\n`);
console.log('## Session Overview\n');
if (start?.attrs) {
  console.log(`- **Copilot:** ${start.attrs.copilotVersion || 'unknown'}`);
  console.log(`- **VS Code:** ${start.attrs.vscodeVersion || 'unknown'}`);
}
console.log(`- **User messages:** ${userMsgs.length}`);
console.log(`- **Turns:** ${turns.length}`);
console.log(`- **Subagents invoked:** ${subagents.length}`);

const firstTs = events[0]?.ts;
const lastTs = events[events.length - 1]?.ts;
if (firstTs && lastTs) {
  const durMin = Math.round((lastTs - firstTs) / 60000);
  console.log(`- **Duration:** ~${durMin} minutes`);
}

// LLM requests
const llm = events.filter(e => e.type === 'llm_request');
const byModel = {};

llm.forEach(e => {
  const m = e.attrs?.model || 'unknown';
  if (!byModel[m]) {
    byModel[m] = {
      calls: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheReadCalls: 0,
      ttft: [],
      dur: [],
      nanoAiu: 0,
    };
  }
  const s = byModel[m];
  s.calls++;
  s.input += e.attrs?.inputTokens || 0;
  s.output += e.attrs?.outputTokens || 0;
  if (typeof e.attrs?.cachedTokens === 'number') {
    s.cacheRead += e.attrs.cachedTokens;
    s.cacheReadCalls++;
  }
  if (e.attrs?.ttft) s.ttft.push(e.attrs.ttft);
  if (e.dur) s.dur.push(e.dur);
  if (e.attrs?.copilotUsageNanoAiu) s.nanoAiu += e.attrs.copilotUsageNanoAiu;
});

console.log('\n## LLM Calls by Model\n');
console.log('| Model | Calls | Input | Output | Cache Read | Cache Miss | Hit % | Avg TTFT | Avg Dur |');
console.log('|-------|------:|------:|-------:|-----------:|-----------:|------:|---------:|--------:|');

Object.entries(byModel).forEach(([model, s]) => {
  const cacheMiss = s.input - s.cacheRead;
  const hitPct = s.input > 0 ? Math.round(s.cacheRead / s.input * 100) : 0;
  const avgTtft = s.ttft.length ? Math.round(s.ttft.reduce((a, b) => a + b) / s.ttft.length) : '-';
  const avgDur = s.dur.length ? Math.round(s.dur.reduce((a, b) => a + b) / s.dur.length) : '-';
  console.log(`| ${model} | ${s.calls} | ${fmt(s.input)} | ${fmt(s.output)} | ${fmt(s.cacheRead)} | ${fmt(cacheMiss)} | ${hitPct}% | ${avgTtft}ms | ${avgDur}ms |`);
});

const totalIn = Object.values(byModel).reduce((a, s) => a + s.input, 0);
const totalOut = Object.values(byModel).reduce((a, s) => a + s.output, 0);
const totalCacheRead = Object.values(byModel).reduce((a, s) => a + s.cacheRead, 0);
const totalCacheMiss = totalIn - totalCacheRead;
const totalAiu = Object.values(byModel).reduce((a, s) => a + s.nanoAiu, 0);
const overallHit = totalIn > 0 ? Math.round(totalCacheRead / totalIn * 100) : 0;

console.log('\n### Token Totals\n');
console.log(`- **Input tokens:** ${fmt(totalIn)}`);
console.log(`- **Output tokens:** ${fmt(totalOut)}`);
console.log(`- **Cache read:** ${fmt(totalCacheRead)} (${overallHit}% of input)`);
console.log(`- **Cache miss (fresh):** ${fmt(totalCacheMiss)}`);
if (totalAiu > 0) {
  console.log(`- **Copilot AIU usage:** ${fmt(totalAiu)} nano-AIU (${(totalAiu / 1e9).toFixed(4)} AIU)`);
}
console.log('\n> Note: Copilot logs only `cachedTokens` (cache **reads**). Cache **writes** are not recorded in `main.jsonl`.');

// Tool calls
const tools = events.filter(e => e.type === 'tool_call');
const byTool = {};
let toolErrors = 0;

tools.forEach(e => {
  const name = e.name || 'unknown';
  byTool[name] = (byTool[name] || 0) + 1;
  if (e.status === 'error') toolErrors++;
});

console.log('\n## Tool Calls\n');
console.log('| Tool | Count |');
console.log('|------|------:|');
Object.entries(byTool).sort((a, b) => b[1] - a[1]).forEach(([tool, count]) => {
  console.log(`| ${tool} | ${count} |`);
});
console.log(`\n**Total:** ${tools.length} calls, ${toolErrors} errors`);

// Errors
const errors = events.filter(e => e.status === 'error');
if (errors.length > 0) {
  console.log('\n## Errors\n');
  errors.forEach(e => {
    const msg = e.attrs?.error || e.attrs?.result || 'unknown error';
    console.log(`- **${e.type}/${e.name}**: ${String(msg).substring(0, 200)}`);
  });
}
