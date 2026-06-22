import Chart from 'chart.js/auto';
import type { DashboardData, BudgetState, BudgetThresholds, RangeSummary, RangePreset } from '../domain/models.js';

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
type InboundMessage = UpdateMessage | RangeMessage;

const vscode = acquireVsCodeApi();

// --- State ---
let data: DashboardData | null = null;
let budgetState: BudgetState | null = null;
let thresholds: BudgetThresholds | null = null;
let displayCurrency: DisplayCurrency = null;
let rangeSummary: RangeSummary | null = null;
let selectedRange: RangePreset = '7d';
let activeTab = 'overview';

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
    data = msg.data;
    budgetState = msg.budgetState;
    thresholds = msg.thresholds;
    displayCurrency = msg.displayCurrency;
    requestRange(selectedRange);
    renderActiveTab();
  } else if (msg.type === 'rangeSummary') {
    rangeSummary = msg.summary;
    renderActiveTab();
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
      activeTab = tab.dataset.tab ?? 'overview';
      document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t === tab));
      renderActiveTab();
    });
  });

  document.querySelectorAll<HTMLElement>('.range-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = btn.dataset.range as RangePreset | undefined;
      if (!preset || preset === selectedRange) return;
      rangeSummary = null;
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
    case 'overview': renderOverview(panel); break;
    case 'activity': renderActivity(panel); break;
    case 'models': renderModels(panel); break;
    case 'budget': renderBudget(panel); break;
  }

  const updated = document.getElementById('updated-at');
  if (updated && data) updated.textContent = 'Updated: ' + new Date(data.updatedAt).toLocaleTimeString();
}

function statCard(label: string, value: string, sub?: string): string {
  return `<div class="card"><div class="card-label">${label}</div>` +
    `<div class="card-value">${value}</div>` +
    (sub ? `<div class="card-sub">${sub}</div>` : '') + '</div>';
}

function convert(cost: number): string {
  return displayCurrency ? ` (~${(cost * displayCurrency.rate).toFixed(2)} ${displayCurrency.code})` : '';
}

function renderOverview(panel: HTMLElement): void {
  if (!data) return;
  const d = data;
  const rangeCost = rangeSummary ? formatCost(rangeSummary.totalCost) : '…';
  panel.innerHTML =
    '<div class="cards">' +
      statCard('Today', formatCost(d.today.totalCost), d.today.modelTurns + ' turns' + convert(d.today.totalCost)) +
      statCard('This Week', formatCost(d.thisWeek.totalCost), d.thisWeek.modelTurns + ' turns') +
      statCard(RANGE_LABELS[selectedRange], rangeCost, rangeSummary ? rangeSummary.modelTurns + ' turns' : '') +
      statCard('Context Weight', formatTokens(d.currentSession.contextWeightTokens), 'latest turn') +
    '</div>' +
    '<div class="chart-wrap"><canvas id="c-overview"></canvas></div>';
  drawDailyCostChart('c-overview');
}

function renderActivity(panel: HTMLElement): void {
  if (!data) return;
  const r = rangeSummary;
  const input = r ? r.inputTokens : data.today.inputTokens;
  const output = r ? r.outputTokens : data.today.outputTokens;
  const cached = r ? r.cachedTokens : data.today.cachedTokens;
  panel.innerHTML =
    '<div class="cards">' +
      statCard('Input Tokens', formatTokens(input)) +
      statCard('Output Tokens', formatTokens(output)) +
      statCard('Cached Tokens', formatTokens(cached)) +
    '</div>' +
    '<div class="chart-wrap"><canvas id="c-activity"></canvas></div>';
  drawTurnsChart('c-activity');
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

function renderBudget(panel: HTMLElement): void {
  if (!data || !thresholds) return;
  const bs = budgetState;
  panel.innerHTML =
    budgetBar('Session', data.currentSession.totalCost, thresholds.session, bs?.sessionLevel) +
    budgetBar('Today', data.today.totalCost, thresholds.daily, bs?.dailyLevel) +
    budgetBar('This Week', data.thisWeek.totalCost, thresholds.weekly, bs?.weeklyLevel);
}

function budgetBar(
  label: string,
  spent: number,
  th: { warning: number; limit: number },
  level: 'ok' | 'warning' | 'limit' | undefined
): string {
  const pct = th.limit > 0 ? Math.min(100, (spent / th.limit) * 100) : 0;
  const color = level === 'limit' ? cssVar('--cost-red')
    : level === 'warning' ? cssVar('--cost-yellow') : cssVar('--cost-green');
  return '<div class="budget">' +
    `<div class="budget-head"><span>${label}</span>` +
    `<span>${formatCost(spent)} / ${formatCost(th.limit)}</span></div>` +
    `<div class="budget-track"><div class="budget-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div></div>` +
    `<div class="budget-sub">warning at ${formatCost(th.warning)}</div></div>`;
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

function drawTurnsChart(canvasId: string): void {
  destroyChart(canvasId);
  const points = rangeSummary && rangeSummary.preset === selectedRange
    ? rangeSummary.daily.map(p => ({ label: p.date.slice(5), value: p.modelTurns }))
    : (data ? data.last7Days.map(b => ({ label: b.dayLabel, value: b.modelTurns })) : []);
  const ctx = document.getElementById(canvasId) as HTMLCanvasElement | null;
  if (!ctx) return;
  charts[canvasId] = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: points.map(p => p.label),
      datasets: [{
        label: 'Model turns',
        data: points.map(p => p.value),
        backgroundColor: cssVar('--accent') || '#3584e4',
        borderRadius: 3,
      }],
    },
    options: baseChartOptions(''),
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
      plugins: { legend: { display: false } },
    },
  });
}

function baseChartOptions(prefix: string): Chart['options'] {
  return {
    responsive: true,
    maintainAspectRatio: false,
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
