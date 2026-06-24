import Chart from 'chart.js/auto';
import type { DashboardData, BudgetState, BudgetThresholds, RangeSummary, RangePreset, RecentPrompt, SpanDetail, ToolCall } from '../domain/models.js';

/** Minimal shape of the VS Code webview API we use. */
interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

type DisplayCurrency = { code: string; rate: number } | null;

interface UpdateMessage {
  type: 'update';
  data: DashboardData;
  budgetState: BudgetState | null;
  thresholds: BudgetThresholds;
  displayCurrency: DisplayCurrency;
}
interface RangeMessage {
  type: 'rangeSummary';
  summary: RangeSummary;
}
interface RecentTurnsMessage {
  type: 'recentTurns';
  turns: RecentPrompt[];
}
type InboundMessage = UpdateMessage | RangeMessage | RecentTurnsMessage;

const vscode = acquireVsCodeApi();

// --- State ---
let data: DashboardData | null = null;
let budgetState: BudgetState | null = null;
let thresholds: BudgetThresholds | null = null;
let displayCurrency: DisplayCurrency = null;
let rangeSummary: RangeSummary | null = null;
let recentTurns: RecentPrompt[] | null = null;
let selectedRange: RangePreset = '7d';
let activeTab = 'activity';
/** traceId of the prompt currently shown in the detail modal, or null. Used to
 * keep the open modal in sync with the 10s data refresh. */
let openModalTraceId: string | null = null;
/** While the modal is open, poll the prompt data at this faster cadence so live
 * tool calls / model calls appear without waiting for the 10s dashboard refresh. */
let modalPollTimer: ReturnType<typeof setInterval> | null = null;
const MODAL_POLL_MS = 1000;

/** When true, the next chart render plays its entrance animation. Set on first
 * render and user interactions (tab/range/section toggle); cleared on the 10s
 * data refresh so re-renders are silent. */
let animateNext = true;
let firstRender = true;
/** Collapsed state per Activity section id (default: expanded). */
const collapsed: Record<string, boolean> = {};
const subagentCollapsed: Record<string, boolean> = {};
const spanToolsExpanded: Record<string, boolean> = {};

const charts: Record<string, Chart> = {};

// --- Formatting helpers ---
function formatCost(cost: number): string {
  if (cost > 0 && cost < 0.001) return '< $0.001';
  return `$${cost.toFixed(3)}`;
}
function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return `${count}`;
}
function shortModel(model: string): string {
  return model.length > 28 ? model.slice(0, 27) + '…' : model;
}
function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

const RANGE_LABELS: Record<RangePreset, string> = { '7d': '7 Days', '30d': '30 Days', '90d': '90 Days' };
const PALETTE = ['#4e9a06', '#3584e4', '#9141ac', '#e66100', '#c01c28', '#1a8fab', '#e5a50a', '#613583'];

// --- Messaging ---
window.addEventListener('message', (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  if (msg.type === 'update') {
    // Animate only the very first render; subsequent polls refresh silently.
    animateNext = firstRender;
    firstRender = false;
    data = msg.data;
    budgetState = msg.budgetState;
    thresholds = msg.thresholds;
    displayCurrency = msg.displayCurrency;
    requestRange(selectedRange);
    renderActiveTab();
    // Refresh the open modal even when the prompts table isn't on screen.
    if (openModalTraceId) vscode.postMessage({ command: 'recentTurns' });
  } else if (msg.type === 'rangeSummary') {
    rangeSummary = msg.summary;
    renderActiveTab();
  } else if (msg.type === 'recentTurns') {
    recentTurns = msg.turns;
    renderRecentTurnsTable();
  }
});

function requestRange(preset: RangePreset): void {
  selectedRange = preset;
  vscode.postMessage({ command: 'rangeSummary', preset });
}

// --- Tab + control wiring ---
function setupChrome(): void {
  document.querySelectorAll<HTMLElement>('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      activeTab = tab.dataset.tab ?? 'activity';
      animateNext = true;
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      renderActiveTab();
    });
  });

  document.querySelectorAll<HTMLElement>('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.range as RangePreset | undefined;
      if (!preset || preset === selectedRange) return;
      rangeSummary = null;
      animateNext = true;
      document.querySelectorAll('.range-btn').forEach(b =>
        b.classList.toggle('active', b === btn));
      requestRange(preset);
      renderActiveTab();
    });
  });

  document.getElementById('btn-refresh')?.addEventListener('click', () =>
    vscode.postMessage({ command: 'refresh' }));
  document.getElementById('btn-settings')?.addEventListener('click', () =>
    vscode.postMessage({ command: 'openSettings' }));

  // Delegated handling for dynamically rendered content inside #panel.
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;

    // KPI info badge -> toggle explainer popover.
    const badge = target.closest('.info-badge') as HTMLElement | null;
    if (badge) {
      e.stopPropagation();
      toggleInfoPopover(badge);
      return;
    }
    // Any other click closes an open popover.
    closeInfoPopover();

    // Modal: close button or backdrop.
    if (target.closest('#modal-close') || target.classList.contains('modal-overlay')) {
      closeModal();
      return;
    }
    // Collapsible section header.
    const head = target.closest('.section-head') as HTMLElement | null;
    if (head?.dataset.section) {
      toggleSection(head.dataset.section);
      return;
    }
    // Collapsible subagent node.
    const sub = target.closest('.detail-child-head') as HTMLElement | null;
    if (sub?.dataset.subagent) {
      toggleSubagent(sub.dataset.subagent);
      return;
    }
    // Model-call row -> expand its tool/function calls.
    const spanRow = target.closest('.span-row') as HTMLElement | null;
    if (spanRow?.dataset.spanId) {
      toggleSpanTools(spanRow.dataset.spanId);
      return;
    }
    // Prompt row -> open the detail modal.
    const row = target.closest('.prompt-row') as HTMLElement | null;
    if (row?.dataset.turnIdx) {
      openModal(Number(row.dataset.turnIdx));
      return;
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeModal(); closeInfoPopover(); }
  });
}

// --- KPI glossary (info-badge explainers) ---
const GLOSSARY: Record<string, { title: string; text: string }> = {
  today: { title: 'Today', text: 'Total estimated Copilot cost for requests made since local midnight.' },
  thisWeek: { title: 'This Week', text: 'Total estimated cost over the last 7 calendar days, including today.' },
  range: { title: 'Selected Range', text: 'Total estimated cost across the selected date window (7, 30, or 90 days).' },
  contextWeight: { title: 'Context Weight', text: 'Approximate size of the prompt sent to the model on the most recent turn (fresh + cached input tokens). Indicates how heavy the conversation context currently is.' },
  inputFresh: { title: 'Input (fresh)', text: 'Newly sent prompt tokens that were not served from cache — billed at the full input rate.' },
  cacheRead: { title: 'Cache Read', text: "Input tokens served from the model's prompt cache. Cheaper than fresh input." },
  cacheWrite: { title: 'Cache Write', text: 'Tokens written into the prompt cache on this request. Billed once, then reused as Cache Read on later turns.' },
  output: { title: 'Output', text: 'Tokens generated by the model in its responses.' },
  costHistory: { title: 'Cost History', text: 'Estimated cost per day across the selected date range.' },
  tokens: { title: 'Tokens', text: 'Token usage split into fresh input, cache read, cache write, and output for the selected range.' },
  costPerPrompt: { title: 'Cost per User Prompt', text: 'Cost broken down by each user message, summing all LLM calls and tool/subagent activity triggered by that prompt. Click a row to see every interaction.' },
  reqs: { title: 'Reqs', text: 'Number of model (LLM) calls made while handling this prompt.' },
  hitPct: { title: 'Hit %', text: 'Share of input tokens served from cache (Cache Read ÷ total input). Higher is cheaper.' },
};

function infoBadge(key: string): string {
  const g = GLOSSARY[key];
  if (!g) return '';
  return `<span class="info-badge" data-info="${key}" role="button" tabindex="0" aria-label="${escapeHtml(g.title)} explainer" title="${escapeHtml(g.title)}">i</span>`;
}

// --- Rendering ---
function renderActiveTab(): void {
  const panel = document.getElementById('panel');
  if (!panel) return;

  if (!data || (data.today.modelTurns === 0 && data.thisWeek.modelTurns === 0)) {
    destroyAllCharts();
    panel.innerHTML = '<div class="empty">No Copilot usage data found yet.</div>';
    return;
  }

  switch (activeTab) {
    case 'activity': renderActivity(panel); break;
    case 'cost': renderCost(panel); break;
    case 'models': renderModels(panel); break;
    default: renderActivity(panel); break;
  }

  const updated = document.getElementById('updated-at');
  if (updated && data) updated.textContent = 'Updated: ' + new Date(data.updatedAt).toLocaleTimeString();
}

function statCard(label: string, value: string, sub?: string, infoKey?: string): string {
  return `<div class="card"><div class="card-label">${label}${infoKey ? infoBadge(infoKey) : ''}</div>` +
    `<div class="card-value">${value}</div>` +
    (sub ? `<div class="card-sub">${sub}</div>` : '') + '</div>';
}

function convert(cost: number): string {
  return displayCurrency ? ` (~${(cost * displayCurrency.rate).toFixed(2)} ${displayCurrency.code})` : '';
}

/** Collapsible section wrapper. */
function section(id: string, title: string, infoKey: string | null, body: string): string {
  const isCol = collapsed[id];
  return '<div class="section">' +
    `<div class="section-head" data-section="${id}">` +
      `<span class="section-chevron">${isCol ? '▸' : '▾'}</span>` +
      `<span class="section-title">${title}</span>` +
      (infoKey ? infoBadge(infoKey) : '') +
    '</div>' +
    `<div class="section-body${isCol ? ' hidden' : ''}" id="sec-${id}">${body}</div>` +
  '</div>';
}

/** Today's cache-write tokens, summed across models (PeriodCost has no top-level field). */
function todayCacheWrite(): number {
  return data ? data.today.byModel.reduce((sum, m) => sum + m.cacheWriteTokens, 0) : 0;
}

function renderCost(panel: HTMLElement): void {
  if (!data) return;
  const d = data;
  const r = rangeSummary;
  const rangeCost = r ? formatCost(r.totalCost) : '…';

  const costCards =
    '<div class="cards">' +
      statCard('Today', formatCost(d.today.totalCost), d.today.modelTurns + ' turns' + convert(d.today.totalCost), 'today') +
      statCard('This Week', formatCost(d.thisWeek.totalCost), d.thisWeek.modelTurns + ' turns', 'thisWeek') +
      statCard(RANGE_LABELS[selectedRange], rangeCost, r ? r.modelTurns + ' turns' : '', 'range') +
      statCard('Context Weight', formatTokens(d.currentSession.contextWeightTokens), 'latest turn', 'contextWeight') +
    '</div>';

  const historyBody = '<div class="chart-wrap"><canvas id="c-cost"></canvas></div>';

  panel.innerHTML =
    section('cost', 'Cost Summary', null, costCards) +
    section('history', 'Cost History', 'costHistory', historyBody);

  if (!collapsed['history']) drawDailyCostChart('c-cost');
}

function renderActivity(panel: HTMLElement): void {
  if (!data) return;
  const d = data;
  const r = rangeSummary;

  const input = r ? r.inputTokens : d.today.inputTokens;
  const output = r ? r.outputTokens : d.today.outputTokens;
  const cacheRead = r ? r.cachedTokens : d.today.cachedTokens;
  const cacheWrite = r ? r.cacheWriteTokens : todayCacheWrite();
  const tokenCards =
    '<div class="cards">' +
      statCard('Input (fresh)', formatTokens(input), '', 'inputFresh') +
      statCard('Cache Read', formatTokens(cacheRead), '', 'cacheRead') +
      statCard('Cache Write', formatTokens(cacheWrite), '', 'cacheWrite') +
      statCard('Output', formatTokens(output), '', 'output') +
    '</div>';

  const promptsBody = '<div id="recent-turns">' + renderRecentTurnsBody() + '</div>';

  panel.innerHTML =
    section('tokens', 'Tokens', 'tokens', tokenCards) +
    section('prompts', 'Cost per User Prompt', 'costPerPrompt', promptsBody);

  vscode.postMessage({ command: 'recentTurns' });
}

/** Toggle a collapsible section, lazily (re)drawing the cost chart on expand. */
function toggleSection(id: string): void {
  collapsed[id] = !collapsed[id];
  const body = document.getElementById('sec-' + id);
  const head = document.querySelector(`.section-head[data-section="${id}"]`);
  if (body) body.classList.toggle('hidden', collapsed[id]);
  if (head) {
    const chevron = head.querySelector('.section-chevron');
    if (chevron) chevron.textContent = collapsed[id] ? '▸' : '▾';
  }
  if (id === 'history') {
    if (collapsed[id]) {
      destroyChart('c-cost');
    } else {
      animateNext = true;
      drawDailyCostChart('c-cost');
    }
  }
}

// --- KPI explainer popover ---
function closeInfoPopover(): void {
  document.getElementById('info-pop')?.remove();
}

function toggleInfoPopover(badge: HTMLElement): void {
  const existing = document.getElementById('info-pop');
  const key = badge.dataset.info ?? '';
  if (existing) {
    const wasSame = existing.dataset.for === key;
    existing.remove();
    if (wasSame) return; // toggle off when clicking the same badge
  }
  const g = GLOSSARY[key];
  if (!g) return;
  const pop = document.createElement('div');
  pop.id = 'info-pop';
  pop.className = 'info-pop';
  pop.dataset.for = key;
  pop.innerHTML = `<div class="info-pop-title">${escapeHtml(g.title)}</div>` +
    `<div class="info-pop-text">${escapeHtml(g.text)}</div>`;
  document.body.appendChild(pop);
  const rect = badge.getBoundingClientRect();
  const top = rect.bottom + window.scrollY + 6;
  const left = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - pop.offsetWidth - 12));
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cacheHitPct(inputTokens: number, cachedTokens: number): string {
  if (inputTokens <= 0) return '0%';
  return Math.round((100 * cachedTokens) / inputTokens) + '%';
}

function renderRecentTurnsBody(): string {
  if (recentTurns === null) return '<div class="prompts-msg">Loading…</div>';
  if (recentTurns.length === 0) return '<div class="prompts-msg">No prompts yet.</div>';
  const rows = recentTurns.map((t, i) => {
    const label = t.label ? escapeHtml(t.label) : '<span class="prompts-muted">(no prompt text)</span>';
    return '<tr class="prompt-row" data-turn-idx="' + i + '" title="Click to see all interactions">' +
      '<td class="prompts-session" title="' + escapeHtml(t.sessionTitle) + '">' + escapeHtml(t.sessionTitle) + '</td>' +
      '<td class="prompts-label" title="' + (t.label ? escapeHtml(t.label) : '') + '">' + label + '</td>' +
      '<td class="num">' + formatCost(t.totalCost) + '</td>' +
      '<td class="num">' + t.llmCalls + '</td>' +
      '<td class="num">' + formatTokens(t.inputTokens) + '</td>' +
      '<td class="num">' + formatTokens(t.outputTokens) + '</td>' +
      '<td class="num">' + cacheHitPct(t.inputTokens, t.cachedTokens) + '</td>' +
      '</tr>';
  }).join('');
  return '<table class="prompts-table">' +
    '<thead><tr><th>Session</th><th>Prompt</th><th class="num">Cost</th>' +
    '<th class="num">Reqs' + infoBadge('reqs') + '</th><th class="num">In</th><th class="num">Out</th>' +
    '<th class="num">Hit%' + infoBadge('hitPct') + '</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

/** Spans + subagent breakdown shown inside the detail modal. */
function renderTurnDetailBody(turn: RecentPrompt): string {
  let html = '';
  if (turn.spans && turn.spans.length > 0) {
    html += '<div class="detail-section-title">Model calls</div>' + renderSpansTable(turn.spans);
  }
  if (turn.children && turn.children.length > 0) {
    html += '<div class="detail-section-title">Subagents</div>';
    turn.children.forEach((child, i) => {
      const key = turn.traceId + '#' + i;
      const isCol = subagentCollapsed[key];
      const toolCount = countNestedTools(child.spans);
      html += '<div class="detail-child">' +
        '<div class="detail-child-head" data-subagent="' + escapeHtml(key) + '">' +
          '<span class="section-chevron">' + (isCol ? '▸' : '▾') + '</span>' +
          '<span class="detail-child-name">' + escapeHtml(child.agentName || 'subagent') + '</span>' +
          '<span class="detail-child-totals">' + formatCost(child.totalCost) + ' · ' +
            child.llmCalls + ' call(s) · ' + toolCount + ' tool(s) · ' +
            formatTokens(child.inputTokens) + ' in / ' + formatTokens(child.outputTokens) + ' out</span>' +
        '</div>' +
        '<div class="detail-child-body' + (isCol ? ' hidden' : '') + '">';
      if (child.spans && child.spans.length > 0) html += renderSpansTable(child.spans);
      if (child.toolCalls && child.toolCalls.length > 0) {
        html += '<div class="detail-subtitle">Unlinked tool calls</div>' + renderToolCallsTable(child.toolCalls);
      }
      html += '</div></div>';
    });
  }
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    html += '<div class="detail-section-title">Unlinked tool calls (' + turn.toolCalls.length + ')</div>' +
      renderToolCallsTable(turn.toolCalls);
  }
  if ((!turn.spans || turn.spans.length === 0) &&
      (!turn.toolCalls || turn.toolCalls.length === 0) &&
      (!turn.children || turn.children.length === 0)) {
    html += '<div class="prompts-msg">No detailed interactions recorded for this prompt.</div>';
  }
  return html;
}

function renderToolCallsTable(calls: ToolCall[]): string {
  const rows = calls.map(c => {
    const op = c.operationName ? escapeHtml(c.operationName) : '—';
    const isErr = c.status === 'error';
    return '<tr>' +
      '<td title="' + escapeHtml(new Date(c.startTimeMs).toLocaleString()) + '">' + formatClock(c.startTimeMs) + '</td>' +
      '<td class="detail-op" title="' + escapeHtml(c.toolName) + '">' + escapeHtml(c.toolName) + '</td>' +
      '<td class="detail-op" title="' + op + '">' + op + '</td>' +
      '<td class="num">' + Math.round(c.durationMs) + 'ms</td>' +
      '<td class="' + (isErr ? 'tool-err' : 'tool-ok') + '">' + (isErr ? 'error' : 'ok') + '</td>' +
      '</tr>';
  }).join('');
  return '<table class="detail-table">' +
    '<thead><tr><th>Time</th><th>Tool</th><th>Operation</th>' +
    '<th class="num">Dur</th><th>Status</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

function tokensPerSec(outputTokens: number, durationMs: number): string {
  if (durationMs <= 0) return '—';
  return Math.round(outputTokens / (durationMs / 1000)) + '/s';
}

/** Total tool/function calls nested under a list of model calls. */
function countNestedTools(spans?: SpanDetail[]): number {
  return (spans ?? []).reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0);
}

function formatClock(ms: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

function renderSpansTable(spans: SpanDetail[]): string {
  const rows = spans.map(sp => {
    const op = sp.operationName ? escapeHtml(sp.operationName) : '—';
    const tools = sp.toolCalls ?? [];
    const hasTools = tools.length > 0;
    const expanded = hasTools && spanToolsExpanded[sp.spanId];
    const toolLabel = tools.length === 1 ? escapeHtml(tools[0].toolName) : String(tools.length) + ' Calls';
    const toolCell = hasTools
      ? '<span class="section-chevron">' + (expanded ? '▾' : '▸') + '</span> ' + toolLabel
      : '—';
    let row = '<tr' + (hasTools ? ' class="span-row clickable" data-span-id="' + escapeHtml(sp.spanId) + '"' : '') + '>' +
      '<td title="' + escapeHtml(new Date(sp.startTimeMs).toLocaleString()) + '">' + formatClock(sp.startTimeMs) + '</td>' +
      '<td title="' + escapeHtml(sp.model) + '">' + escapeHtml(shortModel(sp.model)) + '</td>' +
      '<td class="detail-op" title="' + op + '">' + op + '</td>' +
      '<td class="detail-tools">' + toolCell + '</td>' +
      '<td class="num">' + formatTokens(sp.inputTokens) + '</td>' +
      '<td class="num">' + formatTokens(sp.cachedTokens) + '</td>' +
      '<td class="num">' + formatTokens(sp.cacheWriteTokens) + '</td>' +
      '<td class="num">' + formatTokens(sp.reasoningTokens) + '</td>' +
      '<td class="num">' + formatTokens(sp.outputTokens) + '</td>' +
      '<td class="num">' + tokensPerSec(sp.outputTokens, sp.durationMs) + '</td>' +
      '<td class="num">' + formatCost(sp.totalCost) + '</td>' +
      '<td class="num">' + Math.round(sp.durationMs) + 'ms</td>' +
      '</tr>';
    if (expanded) {
      row += '<tr class="span-tools-row"><td colspan="12"><div class="span-tools-wrap">' +
        renderToolCallsTable(tools) + '</div></td></tr>';
    }
    return row;
  }).join('');
  return '<table class="detail-table">' +
    '<thead><tr>' +
    '<th title="Local start time of the call">Time</th>' +
    '<th>Model</th>' +
    '<th title="The trace operation (e.g. chat, embeddings)">Operation</th>' +
    '<th title="Tool/function calls this model call made — click a row to expand">Tool Call</th>' +
    '<th class="num">In</th>' +
    '<th class="num" title="Cached tokens read from the prompt cache">Cache Read</th>' +
    '<th class="num" title="Tokens written to the prompt cache">Cache Write</th>' +
    '<th class="num" title="Reasoning tokens generated (reasoning models)">Reasoning</th>' +
    '<th class="num">Out</th>' +
    '<th class="num" title="Output tokens per second">Tok/s</th>' +
    '<th class="num">Cost</th>' +
    '<th class="num" title="Call duration">Dur</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

// --- Prompt detail modal ---
function renderModalBody(turn: RecentPrompt): void {
  const body = document.getElementById('modal-body');
  const title = document.getElementById('modal-title');
  if (!body) return;
  if (title) title.textContent = turn.label || turn.sessionTitle || 'Prompt detail';
  // Preserve scroll position across live refreshes.
  const scroll = body.scrollTop;
  body.innerHTML =
    '<div class="detail-summary">' + turn.llmCalls + ' LLM call(s) · ' + formatCost(turn.totalCost) + ' · ' +
      formatTokens(turn.inputTokens) + ' in / ' + formatTokens(turn.outputTokens) + ' out</div>' +
    renderTurnDetailBody(turn);
  body.scrollTop = scroll;
}

/** Toggle a subagent node, re-rendering the open modal so totals stay visible. */
function toggleSubagent(key: string): void {
  subagentCollapsed[key] = !subagentCollapsed[key];
  if (openModalTraceId && recentTurns) {
    const turn = recentTurns.find(t => t.traceId === openModalTraceId);
    if (turn) renderModalBody(turn);
  }
}

/** Toggle the nested tool calls under a model-call row. */
function toggleSpanTools(spanId: string): void {
  spanToolsExpanded[spanId] = !spanToolsExpanded[spanId];
  if (openModalTraceId && recentTurns) {
    const turn = recentTurns.find(t => t.traceId === openModalTraceId);
    if (turn) renderModalBody(turn);
  }
}

function startModalPolling(): void {
  stopModalPolling();
  modalPollTimer = setInterval(() => {
    if (openModalTraceId) vscode.postMessage({ command: 'recentTurns' });
  }, MODAL_POLL_MS);
}

function stopModalPolling(): void {
  if (modalPollTimer !== null) { clearInterval(modalPollTimer); modalPollTimer = null; }
}

function openModal(idx: number): void {
  if (!recentTurns) return;
  const turn = recentTurns[idx];
  if (!turn) return;
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  openModalTraceId = turn.traceId;
  renderModalBody(turn);
  overlay.classList.remove('hidden');
  startModalPolling();
}

function closeModal(): void {
  openModalTraceId = null;
  stopModalPolling();
  document.getElementById('modal-overlay')?.classList.add('hidden');
}

function renderRecentTurnsTable(): void {
  const el = document.getElementById('recent-turns');
  if (el) el.innerHTML = renderRecentTurnsBody();
  // Keep an open modal in sync with refreshed data (10s poll).
  if (openModalTraceId && recentTurns) {
    const turn = recentTurns.find(t => t.traceId === openModalTraceId);
    if (turn) renderModalBody(turn);
  }
}

function renderModels(panel: HTMLElement): void {
  const source = rangeSummary ? rangeSummary.byModel : (data ? data.today.byModel : []);
  if (!source || source.length === 0) {
    destroyAllCharts();
    panel.innerHTML = '<div class="empty">No model usage in this range yet.</div>';
    return;
  }
  const rows = source.map((m, i) =>
    `<div class="model-row"><span class="dot" style="background:${PALETTE[i % PALETTE.length]}"></span>` +
    `<span class="model-name">${shortModel(m.model)}</span>` +
    `<span class="model-cost">${formatCost(m.totalCost)}</span></div>`).join('');
  panel.innerHTML =
    '<div class="chart-wrap small"><canvas id="c-models"></canvas></div>' +
    '<div class="model-table">' + rows + '</div>';
  drawModelDoughnut('c-models', source);
}

// --- Charts ---
function destroyChart(id: string): void {
  if (charts[id]) { charts[id].destroy(); delete charts[id]; }
}
function destroyAllCharts(): void {
  for (const id of Object.keys(charts)) destroyChart(id);
}

function chartGrid(): string { return cssVar('--card-border') || 'rgba(127,127,127,0.2)'; }
function chartText(): string { return cssVar('--text-secondary') || '#888'; }

function drawDailyCostChart(canvasId: string): void {
  destroyChart(canvasId);
  const points = rangeSummary && rangeSummary.preset === selectedRange
    ? rangeSummary.daily.map(p => ({ label: p.date.slice(5), value: p.totalCost }))
    : (data ? data.last7Days.map(b => ({ label: b.dayLabel, value: b.totalCost })) : []);
  const ctx = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!ctx) return;
  charts[canvasId] = new Chart(ctx, {
    type: 'line',
    data: {
      labels: points.map(p => p.label),
      datasets: [{
        label: 'Cost (USD)',
        data: points.map(p => p.value),
        borderColor: cssVar('--accent') || '#3584e4',
        backgroundColor: 'rgba(53,132,228,0.15)',
        fill: true,
        tension: 0.3,
        pointRadius: 2,
      }],
    },
    options: baseChartOptions('$'),
  });
}

function drawModelDoughnut(canvasId: string, models: { model: string; totalCost: number }[]): void {
  destroyChart(canvasId);
  const ctx = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!ctx) return;
  charts[canvasId] = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: models.map(m => shortModel(m.model)),
      datasets: [{
        data: models.map(m => m.totalCost),
        backgroundColor: models.map((_, i) => PALETTE[i % PALETTE.length]),
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: animateNext ? undefined : false,
      plugins: { legend: { display: false } },
    },
  });
}

function baseChartOptions(prefix: string): Chart['options'] {
  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: animateNext ? undefined : false,
    plugins: { legend: { display: false } },
    scales: {
      x: { grid: { color: chartGrid() }, ticks: { color: chartText() } },
      y: {
        grid: { color: chartGrid() },
        ticks: {
          color: chartText(),
          callback: (v) => prefix + v,
        },
        beginAtZero: true,
      },
    },
  };
}

// --- Boot ---
setupChrome();
vscode.postMessage({ command: 'ready' });
