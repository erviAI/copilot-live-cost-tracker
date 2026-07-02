import Chart from 'chart.js/auto';
import type { DashboardData, BudgetState, BudgetThresholds, RangeSummary, RangePreset, RecentPrompt, SpanDetail, ToolCall, SessionInfo, TurnCost } from '../domain/models.js';

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
interface SessionTurnsMessage {
  type: 'sessionTurns';
  sessionId: string;
  turns: RecentPrompt[];
}
interface OpenSessionModalMessage {
  type: 'openSessionModal';
  sessionId: string;
  traceId?: string;
}
type InboundMessage = UpdateMessage | RangeMessage | SessionTurnsMessage | OpenSessionModalMessage;

const vscode = acquireVsCodeApi();

// --- State ---
let data: DashboardData | null = null;
let budgetState: BudgetState | null = null;
let thresholds: BudgetThresholds | null = null;
let displayCurrency: DisplayCurrency = null;
let rangeSummary: RangeSummary | null = null;
/** Per-session lazy cache of prompt detail. 'loading' while a fetch is in flight. */
const sessionTurns: Record<string, RecentPrompt[] | 'loading'> = {};
let selectedRange: RangePreset = '7d';
let activeTab = 'activity';
/** traceId of the prompt currently shown in the detail modal, or null. Used to
 * keep the open modal in sync with the 10s data refresh. */
let openModalTraceId: string | null = null;
/** sessionId of the session currently shown in the session-detail modal, or null. */
let openModalSessionId: string | null = null;
/** sessionId backing an open prompt-detail modal (prompt modals are keyed by traceId). */
let openPromptSessionId: string | null = null;
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
/** Expanded state per tool-call span id (shows args/result/error). Default collapsed. */
const toolDetailExpanded: Record<string, boolean> = {};
/** Collapsed state per prompt/response text panel (keyed by type#traceId). */
const textPanelCollapsed: Record<string, boolean> = {};
/** Session ids expanded in the Activity table (default: all collapsed). */
const expandedSessions = new Set<string>();
/** Per-prompt collapse state inside the session modal (keyed by traceId). */
const sessionModalTurnCollapsed: Record<string, boolean> = {};
/** Pending session modal request (from the sidebar) awaiting per-session turn data. */
let pendingSessionModal: { sessionId: string; traceId?: string } | null = null;
/** Last-rendered fingerprints; used to skip redundant re-renders so an open tool
 * args/result panel keeps its scroll position and text selection. */
let lastTableSig = '';
let lastModalSig = '';

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
    // Re-fetch detail for on-screen sessions so live tool/model calls appear.
    refreshOpenSessionData();
  } else if (msg.type === 'rangeSummary') {
    rangeSummary = msg.summary;
    renderActiveTab();
  } else if (msg.type === 'sessionTurns') {
    sessionTurns[msg.sessionId] = msg.turns;
    onSessionTurnsLoaded(msg.sessionId);
  } else if (msg.type === 'openSessionModal') {
    openSessionModal(msg.sessionId, msg.traceId);
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
    // Tool-call row -> expand its arguments / result / error detail.
    const toolRow = target.closest('.tool-row') as HTMLElement | null;
    if (toolRow?.dataset.toolSpanId) {
      toggleToolDetail(toolRow.dataset.toolSpanId);
      return;
    }
    // Prompt / Response text panel header -> expand/collapse full text.
    const textHead = target.closest('.text-panel-head') as HTMLElement | null;
    if (textHead?.dataset.textpanel) {
      toggleTextPanel(textHead.dataset.textpanel);
      return;
    }
    // Model-call row -> expand its tool/function calls.
    const spanRow = target.closest('.span-row') as HTMLElement | null;
    if (spanRow?.dataset.spanId) {
      toggleSpanTools(spanRow.dataset.spanId);
      return;
    }
    // Session modal: prompt entry header -> expand/collapse its detail.
    const sessionTurn = target.closest('.session-prompt-head') as HTMLElement | null;
    if (sessionTurn?.dataset.sessionTurn) {
      toggleSessionModalTurn(sessionTurn.dataset.sessionTurn);
      return;
    }
    // Session header row: clicking the Session column opens the detail modal;
    // clicking any other column expands/collapses the prompt sub-rows inline.
    const sessionRow = target.closest('.session-row') as HTMLElement | null;
    if (sessionRow?.dataset.sessionId) {
      if (target.closest('.session-cell')) openSessionModal(sessionRow.dataset.sessionId);
      else toggleSessionExpand(sessionRow.dataset.sessionId);
      return;
    }
    // Prompt row -> open the detail modal.
    const row = target.closest('.prompt-row') as HTMLElement | null;
    if (row?.dataset.traceId && row.dataset.sessionId) {
      openModal(row.dataset.sessionId, row.dataset.traceId);
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
  contextWeight: { title: 'Context Weight', text: 'Approximate size of the prompt sent to the model on the most recent turn (total input tokens, including any cached tokens). Indicates how heavy the conversation context currently is.' },
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

  lastTableSig = tableSig();
  ensureExpandedLoaded();
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

interface SessionGroup {
  sessionId: string;
  title: string;
  info: SessionInfo | null;
  /** Prompts in this session, paired with their index within the loaded turn list. */
  items: { turn: RecentPrompt; idx: number }[];
}

/** SessionInfo for a session id from the latest dashboard data. */
function sessionInfoFor(sessionId: string): SessionInfo | null {
  return data?.recentSessions.find(s => s.sessionId === sessionId) ?? null;
}

/** Build a SessionGroup from a session's aggregate info + lazily-loaded turns. */
function sessionGroupFor(info: SessionInfo): SessionGroup {
  const loaded = sessionTurns[info.sessionId];
  const items = Array.isArray(loaded) ? loaded.map((turn, idx) => ({ turn, idx })) : [];
  return { sessionId: info.sessionId, title: info.title, info, items };
}

function sessionGroupById(sessionId: string): SessionGroup | null {
  const info = sessionInfoFor(sessionId);
  return info ? sessionGroupFor(info) : null;
}

/** True when a session's per-prompt detail has finished loading. */
function sessionLoaded(sessionId: string): boolean {
  return Array.isArray(sessionTurns[sessionId]);
}

/** Lazily request one session's per-prompt detail. `force` re-fetches loaded data
 * (used by live refreshes) without flipping the row back to a loading state. */
function requestSessionTurns(sessionId: string, force = false): void {
  const state = sessionTurns[sessionId];
  if (!force && state !== undefined) return; // already loading or loaded
  if (state === undefined) sessionTurns[sessionId] = 'loading';
  vscode.postMessage({ command: 'sessionTurns', sessionId });
}

/** Kick off lazy loads for any expanded-but-unloaded sessions after a tab render. */
function ensureExpandedLoaded(): void {
  for (const id of expandedSessions) if (sessionTurns[id] === undefined) requestSessionTurns(id);
}

/** Session id backing whichever modal is open (prompt or session), or null. */
function openModalSession(): string | null {
  return openModalSessionId ?? openPromptSessionId;
}

/** Re-fetch detail for sessions whose detail is on screen (open modal + expanded
 * rows) so live tool/model calls appear without reloading everything. */
function refreshOpenSessionData(): void {
  const ids = new Set<string>();
  const ms = openModalSession();
  if (ms) ids.add(ms);
  for (const id of expandedSessions) ids.add(id);
  for (const id of ids) requestSessionTurns(id, true);
}

/** Handle freshly-loaded session detail: open a pending modal, then refresh the
 * table and any open modal — each guarded so unchanged data triggers no re-render. */
function onSessionTurnsLoaded(sessionId: string): void {
  if (pendingSessionModal && pendingSessionModal.sessionId === sessionId) {
    const req = pendingSessionModal;
    pendingSessionModal = null;
    openSessionModal(req.sessionId, req.traceId);
  }
  maybeRenderTable();
  maybeRefreshOpenModal();
}

/** A compact fingerprint of a turn's cost-bearing data; changes only when the
 * displayed numbers/content actually change. */
function turnSig(t: TurnCost): string {
  return [t.traceId, t.totalCost, t.llmCalls, countTurnTools(t), t.inputTokens, t.outputTokens,
    t.spans?.length ?? 0, t.children?.length ?? 0,
    (t.promptText ?? '').length, (t.responseText ?? '').length].join('|');
}

/** Fingerprint of the whole Activity table (sessions, aggregates, expansion, detail). */
function tableSig(): string {
  return (data?.recentSessions ?? []).map(s => {
    const exp = expandedSessions.has(s.sessionId) ? 'E' : 'c';
    const loaded = sessionTurns[s.sessionId];
    const detail = Array.isArray(loaded) ? loaded.map(turnSig).join(',') : String(loaded ?? 'none');
    return [s.sessionId, exp, s.totalCost, s.modelTurns, s.inputTokens, s.outputTokens, detail].join(':');
  }).join('|');
}

/** Rebuild the Activity prompts table only when its data fingerprint changed. */
function maybeRenderTable(): void {
  const el = document.getElementById('recent-turns');
  if (!el) return;
  const sig = tableSig();
  if (sig === lastTableSig) return;
  lastTableSig = sig;
  el.innerHTML = renderRecentTurnsBody();
}

function isModalOpen(): boolean {
  return openModalTraceId !== null || openModalSessionId !== null;
}

/** Fingerprint of the data shown in the open modal. */
function modalSig(): string {
  if (openModalTraceId && openPromptSessionId) {
    const turns = sessionTurns[openPromptSessionId];
    if (!Array.isArray(turns)) return 'loading';
    const t = turns.find(x => x.traceId === openModalTraceId);
    return t ? turnSig(t) : 'none';
  }
  if (openModalSessionId) {
    const turns = sessionTurns[openModalSessionId];
    if (!Array.isArray(turns)) return 'loading';
    return turns.map(turnSig).join(';');
  }
  return '';
}

/** Render the open modal (prompt or session) unconditionally. */
function renderOpenModal(): void {
  if (openModalTraceId && openPromptSessionId) {
    const turns = sessionTurns[openPromptSessionId];
    if (Array.isArray(turns)) {
      const turn = turns.find(t => t.traceId === openModalTraceId);
      if (turn) renderModalBody(turn);
    }
  } else if (openModalSessionId) {
    const group = sessionGroupById(openModalSessionId);
    if (group && sessionLoaded(openModalSessionId)) renderSessionModalBody(group);
  }
  lastModalSig = modalSig();
}

/** Re-render the open modal only when its underlying data changed (live refresh). */
function maybeRefreshOpenModal(): void {
  if (!isModalOpen()) return;
  if (modalSig() === lastModalSig) return;
  renderOpenModal();
}

/** Exact session totals from SessionInfo when available, else summed from the
 * visible prompts. Prompt `count` always reflects the rows actually shown. */
function sessionAggregate(g: SessionGroup): { count: number; reqs: number; cost: number; input: number; output: number; cached: number } {
  const count = g.items.length;
  if (g.info) {
    return { count, reqs: g.info.modelTurns, cost: g.info.totalCost, input: g.info.inputTokens, output: g.info.outputTokens, cached: g.info.cachedTokens };
  }
  const sum = g.items.reduce((a, { turn }) => ({
    reqs: a.reqs + turn.llmCalls,
    cost: a.cost + turn.totalCost,
    input: a.input + turn.inputTokens,
    output: a.output + turn.outputTokens,
    cached: a.cached + turn.cachedTokens,
  }), { reqs: 0, cost: 0, input: 0, output: 0, cached: 0 });
  return { count, ...sum };
}

/** One prompt sub-row inside an expanded session. */
function renderPromptRow(t: RecentPrompt, sessionId: string): string {
  const label = t.label ? escapeHtml(t.label) : '<span class="prompts-muted">(no prompt text)</span>';
  return '<tr class="prompt-row prompt-subrow" data-session-id="' + escapeHtml(sessionId) + '" data-trace-id="' + escapeHtml(t.traceId) + '" title="Click to see all interactions">' +
    '<td class="prompts-session"></td>' +
    '<td class="prompts-label prompt-indent" title="' + (t.label ? escapeHtml(t.label) : '') + '">' + label + '</td>' +
    '<td class="num">' + formatCost(t.totalCost) + '</td>' +
    '<td class="num">' + t.llmCalls + '</td>' +
    '<td class="num">' + formatTokens(t.inputTokens) + '</td>' +
    '<td class="num">' + formatTokens(t.outputTokens) + '</td>' +
    '<td class="num">' + cacheHitPct(t.inputTokens, t.cachedTokens) + '</td>' +
    '</tr>';
}

/** Session header row plus its prompt sub-rows when expanded. */
function renderSessionGroup(g: SessionGroup): string {
  const expanded = expandedSessions.has(g.sessionId);
  const agg = sessionAggregate(g);
  const loaded = sessionLoaded(g.sessionId);
  const chevron = expanded ? '▾' : '▸';
  const countLabel = loaded
    ? '<span class="prompts-muted">' + agg.count + ' prompt' + (agg.count === 1 ? '' : 's') + '</span>'
    : '';
  let html = '<tr class="session-row" data-session-id="' + escapeHtml(g.sessionId) + '" title="Click to ' + (expanded ? 'collapse' : 'expand') + '">' +
    '<td class="prompts-session session-cell" title="Open session detail">' +
      '<span class="session-name">' + escapeHtml(g.title) + '</span>' +
    '</td>' +
    '<td class="prompts-label session-expand-cell">' +
      '<span class="section-chevron">' + chevron + '</span>' +
      countLabel + '</td>' +
    '<td class="num">' + formatCost(agg.cost) + '</td>' +
    '<td class="num">' + agg.reqs + '</td>' +
    '<td class="num">' + formatTokens(agg.input) + '</td>' +
    '<td class="num">' + formatTokens(agg.output) + '</td>' +
    '<td class="num">' + cacheHitPct(agg.input, agg.cached) + '</td>' +
    '</tr>';
  if (expanded) {
    if (loaded) {
      html += g.items.length
        ? g.items.map(({ turn }) => renderPromptRow(turn, g.sessionId)).join('')
        : '<tr class="prompt-subrow"><td class="prompts-session"></td><td class="prompts-label prompt-indent prompts-muted" colspan="6">No prompts recorded.</td></tr>';
    } else {
      html += '<tr class="prompt-subrow"><td class="prompts-session"></td><td class="prompts-label prompt-indent prompts-muted" colspan="6">Loading…</td></tr>';
    }
  }
  return html;
}

function renderRecentTurnsBody(): string {
  const sessions = data?.recentSessions ?? [];
  if (sessions.length === 0) return '<div class="prompts-msg">No prompts yet.</div>';
  const rows = sessions.map(info => renderSessionGroup(sessionGroupFor(info))).join('');
  return '<table class="prompts-table">' +
    '<thead><tr><th>Session</th><th>Prompt</th><th class="num">Cost</th>' +
    '<th class="num">Reqs' + infoBadge('reqs') + '</th><th class="num">In</th><th class="num">Out</th>' +
    '<th class="num">Hit%' + infoBadge('hitPct') + '</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

/** Spans + subagent breakdown shown inside the detail modal. */
function renderTurnDetailBody(turn: RecentPrompt): string {
  let html = renderTurnTextSections(turn);
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
      (!turn.children || turn.children.length === 0) &&
      !turn.promptText && !turn.responseText) {
    html += '<div class="prompts-msg">No detailed interactions recorded for this prompt.</div>';
  }
  return html;
}

function renderToolCallsTable(calls: ToolCall[]): string {
  const rows = calls.map(c => {
    const op = c.operationName ? escapeHtml(c.operationName) : '—';
    const isErr = c.status === 'error';
    const hasDetail = !!(c.args || c.result || (isErr && c.statusMessage));
    const expanded = hasDetail && !!toolDetailExpanded[c.spanId];
    const nameHover = c.args ? compactArgs(c.args) : c.toolName;
    const nameCell = (hasDetail ? '<span class="section-chevron">' + (expanded ? '▾' : '▸') + '</span> ' : '') +
      escapeHtml(c.toolName);
    let row = '<tr' + (hasDetail ? ' class="tool-row clickable" data-tool-span-id="' + escapeHtml(c.spanId) + '" title="Click to see arguments / result"' : '') + '>' +
      '<td title="' + escapeHtml(new Date(c.startTimeMs).toLocaleString()) + '">' + formatClock(c.startTimeMs) + '</td>' +
      '<td class="detail-op" title="' + escapeHtml(nameHover) + '">' + nameCell + '</td>' +
      '<td class="detail-op" title="' + op + '">' + op + '</td>' +
      '<td class="num">' + Math.round(c.durationMs) + 'ms</td>' +
      '<td class="' + (isErr ? 'tool-err' : 'tool-ok') + '">' + (isErr ? 'error' : 'ok') + '</td>' +
      '</tr>';
    if (expanded) {
      row += '<tr class="tool-detail-row"><td colspan="5"><div class="tool-detail-wrap">' +
        renderToolDetail(c) + '</div></td></tr>';
    }
    return row;
  }).join('');
  return '<table class="detail-table">' +
    '<thead><tr><th>Time</th><th>Tool</th><th>Operation</th>' +
    '<th class="num">Dur</th><th>Status</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table>';
}

/** Pretty-print a JSON string; fall back to the raw text when not valid JSON. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

/** Collapse whitespace and truncate for an inline hover tooltip. */
function compactArgs(raw: string): string {
  const s = raw.replace(/\s+/g, ' ').trim();
  return s.length > 300 ? s.slice(0, 300) + '…' : s;
}

/** Expanded args / result / error detail for a single tool call. */
function renderToolDetail(c: ToolCall): string {
  let html = '';
  if (c.args) {
    html += '<div class="tool-detail-block"><div class="tool-detail-label">Arguments</div>' +
      '<pre class="tool-detail-pre">' + escapeHtml(prettyJson(c.args)) + '</pre></div>';
  }
  if (c.status === 'error' && c.statusMessage) {
    html += '<div class="tool-detail-block"><div class="tool-detail-label">Error</div>' +
      '<pre class="tool-detail-pre tool-detail-err">' + escapeHtml(c.statusMessage) + '</pre></div>';
  }
  if (c.result) {
    html += '<div class="tool-detail-block"><div class="tool-detail-label">Result</div>' +
      '<pre class="tool-detail-pre">' + escapeHtml(prettyJson(c.result)) + '</pre></div>';
  }
  return html || '<div class="prompts-muted">No details captured.</div>';
}

/** Collapsible Prompt / Response panels for a turn (full text from session-store.db). */
function renderTurnTextSections(turn: TurnCost): string {
  let html = '';
  if (turn.promptText) html += renderTextPanel('Prompt', turn.promptText, 'prompt#' + turn.traceId, false);
  if (turn.responseText) html += renderTextPanel('Response', turn.responseText, 'response#' + turn.traceId, true);
  return html;
}

/** A single collapsible text panel; long content is shown on expand. */
function renderTextPanel(title: string, text: string, key: string, defaultCollapsed: boolean): string {
  const collapsedNow = textPanelCollapsed[key] ?? defaultCollapsed;
  const chevron = collapsedNow ? '▸' : '▾';
  const preview = text.replace(/\s+/g, ' ').trim();
  const previewShort = preview.length > 120 ? preview.slice(0, 120) + '…' : preview;
  return '<div class="text-panel">' +
    '<div class="text-panel-head" data-textpanel="' + escapeHtml(key) + '">' +
      '<span class="section-chevron">' + chevron + '</span>' +
      '<span class="text-panel-title">' + escapeHtml(title) + '</span>' +
      (collapsedNow ? '<span class="text-panel-preview">' + escapeHtml(previewShort) + '</span>' : '') +
    '</div>' +
    (collapsedNow ? '' : '<pre class="text-panel-pre">' + escapeHtml(text) + '</pre>') +
    '</div>';
}

function tokensPerSec(outputTokens: number, durationMs: number): string {
  if (durationMs <= 0) return '—';
  return Math.round(outputTokens / (durationMs / 1000)) + '/s';
}

/** Total tool/function calls nested under a list of model calls. */
function countNestedTools(spans?: SpanDetail[]): number {
  return (spans ?? []).reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0);
}

/** Total tool/function calls in a turn: model-call tools + unlinked + subagents. */
function countTurnTools(turn: TurnCost): number {
  let n = countNestedTools(turn.spans) + (turn.toolCalls?.length ?? 0);
  for (const child of turn.children ?? []) n += countTurnTools(child);
  return n;
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
    '<div class="detail-summary">' + turn.llmCalls + ' LLM call(s) · ' + countTurnTools(turn) + ' tool call(s) · ' +
      formatCost(turn.totalCost) + ' · ' +
      formatTokens(turn.inputTokens) + ' in / ' + formatTokens(turn.outputTokens) + ' out · ' +
      cacheHitPct(turn.inputTokens, turn.cachedTokens) + ' cache hit</div>' +
    renderTurnDetailBody(turn);
  body.scrollTop = scroll;
}

/** Aggregate summary + per-prompt (collapsible) entries for the session modal. */
function renderSessionModalBody(group: SessionGroup): void {
  const body = document.getElementById('modal-body');
  const title = document.getElementById('modal-title');
  if (!body) return;
  if (title) title.textContent = group.title || 'Session detail';
  const agg = sessionAggregate(group);
  // Preserve scroll position across live refreshes.
  const scroll = body.scrollTop;
  const sessionTools = group.items.reduce((n, { turn }) => n + countTurnTools(turn), 0);
  let html = '<div class="detail-summary">' + agg.count + ' prompt' + (agg.count === 1 ? '' : 's') + ' · ' +
    agg.reqs + ' LLM call(s) · ' + sessionTools + ' tool call(s) · ' + formatCost(agg.cost) + ' · ' +
    formatTokens(agg.input) + ' in / ' + formatTokens(agg.output) + ' out · ' +
    cacheHitPct(agg.input, agg.cached) + ' cache hit</div>' +
    '<div class="session-prompts">';
  for (const { turn } of group.items) {
    const isCol = sessionModalTurnCollapsed[turn.traceId] !== false; // default collapsed
    const label = turn.label ? escapeHtml(turn.label) : '(no prompt text)';
    html += '<div class="session-prompt">' +
      '<div class="session-prompt-head" data-session-turn="' + escapeHtml(turn.traceId) + '">' +
        '<span class="section-chevron">' + (isCol ? '▸' : '▾') + '</span>' +
        '<span class="session-prompt-label" title="' + (turn.label ? escapeHtml(turn.label) : '') + '">' + label + '</span>' +
        '<span class="session-prompt-totals">' + formatCost(turn.totalCost) + ' · ' + turn.llmCalls + ' call(s) · ' +
          countTurnTools(turn) + ' tool call(s) · ' +
          formatTokens(turn.inputTokens) + ' in / ' + formatTokens(turn.outputTokens) + ' out · ' +
          cacheHitPct(turn.inputTokens, turn.cachedTokens) + ' hit</span>' +
      '</div>' +
      '<div class="session-prompt-body' + (isCol ? ' hidden' : '') + '">' +
        (isCol ? '' : renderTurnDetailBody(turn)) +
      '</div>' +
    '</div>';
  }
  html += '</div>';
  body.innerHTML = html;
  body.scrollTop = scroll;
}

/** Toggle a subagent node, re-rendering the open modal so totals stay visible. */
function toggleSubagent(key: string): void {
  subagentCollapsed[key] = !subagentCollapsed[key];
  renderOpenModal();
}

/** Toggle the nested tool calls under a model-call row. */
function toggleSpanTools(spanId: string): void {
  spanToolsExpanded[spanId] = !spanToolsExpanded[spanId];
  renderOpenModal();
}

/** Toggle the args/result/error detail under a tool-call row. */
function toggleToolDetail(spanId: string): void {
  toolDetailExpanded[spanId] = !toolDetailExpanded[spanId];
  renderOpenModal();
}

/** Toggle a Prompt / Response full-text panel. */
function toggleTextPanel(key: string): void {
  const defaultCollapsed = key.startsWith('response#');
  const collapsedNow = textPanelCollapsed[key] ?? defaultCollapsed;
  textPanelCollapsed[key] = !collapsedNow;
  renderOpenModal();
}

/** Toggle a prompt entry inside the session modal. */
function toggleSessionModalTurn(traceId: string): void {
  const collapsedNow = sessionModalTurnCollapsed[traceId] !== false;
  sessionModalTurnCollapsed[traceId] = !collapsedNow;
  renderOpenModal();
}

/** Expand/collapse a session's prompt sub-rows in the Activity table (lazy-loads). */
function toggleSessionExpand(sessionId: string): void {
  if (expandedSessions.has(sessionId)) expandedSessions.delete(sessionId);
  else { expandedSessions.add(sessionId); requestSessionTurns(sessionId); }
  maybeRenderTable();
}

function startModalPolling(): void {
  stopModalPolling();
  modalPollTimer = setInterval(() => {
    const id = openModalSession();
    if (id) requestSessionTurns(id, true);
  }, MODAL_POLL_MS);
}

function stopModalPolling(): void {
  if (modalPollTimer !== null) { clearInterval(modalPollTimer); modalPollTimer = null; }
}

function openModal(sessionId: string, traceId: string): void {
  const turns = sessionTurns[sessionId];
  if (!Array.isArray(turns)) return;
  const turn = turns.find(t => t.traceId === traceId);
  if (!turn) return;
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  openModalSessionId = null;
  openPromptSessionId = sessionId;
  openModalTraceId = traceId;
  renderModalBody(turn);
  lastModalSig = modalSig();
  overlay.classList.remove('hidden');
  startModalPolling();
}

/** Open the session-detail modal: aggregate summary + per-prompt entries.
 * When `expandTraceId` is given, that prompt is auto-expanded. Detail is
 * lazy-loaded; a Loading… placeholder shows until it arrives. */
function openSessionModal(sessionId: string, expandTraceId?: string): void {
  const overlay = document.getElementById('modal-overlay');
  if (!overlay) return;
  openModalTraceId = null;
  openPromptSessionId = null;
  openModalSessionId = sessionId;
  if (expandTraceId) sessionModalTurnCollapsed[expandTraceId] = false;
  if (sessionLoaded(sessionId)) {
    const group = sessionGroupById(sessionId);
    if (group) renderSessionModalBody(group);
  } else {
    pendingSessionModal = { sessionId, traceId: expandTraceId };
    requestSessionTurns(sessionId);
    const body = document.getElementById('modal-body');
    const title = document.getElementById('modal-title');
    if (title) title.textContent = sessionInfoFor(sessionId)?.title || 'Session detail';
    if (body) body.innerHTML = '<div class="prompts-msg">Loading…</div>';
  }
  lastModalSig = modalSig();
  overlay.classList.remove('hidden');
  startModalPolling();
}

function closeModal(): void {
  openModalTraceId = null;
  openModalSessionId = null;
  openPromptSessionId = null;
  stopModalPolling();
  document.getElementById('modal-overlay')?.classList.add('hidden');
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
