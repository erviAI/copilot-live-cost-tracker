import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { DashboardData, BudgetState, SessionDetailData, RangePreset, RangeSummary } from '../domain/models.js';
import { getDisplayCurrency } from '../config.js';

/**
 * SidebarWebviewProvider renders the cost dashboard in the activity bar sidebar.
 * Communicates with the webview via postMessage for updates.
 */
export class SidebarWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'copilotLiveCostTracker.dashboard';

  private view: vscode.WebviewView | undefined;
  private pendingData: DashboardData | null = null;
  private pendingBudgetState: BudgetState | null = null;
  private sessionDetailHandler: ((sessionId: string) => Promise<SessionDetailData | null>) | null = null;
  private rangeSummaryHandler: ((preset: RangePreset) => Promise<RangeSummary>) | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Set the handler called when the webview requests session detail */
  setSessionDetailHandler(handler: (sessionId: string) => Promise<SessionDetailData | null>): void {
    this.sessionDetailHandler = handler;
  }

  /** Set the handler called when the webview requests a date-range summary */
  setRangeSummaryHandler(handler: (preset: RangePreset) => Promise<RangeSummary>): void {
    this.rangeSummaryHandler = handler;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtml();

    // Handle messages from webview
    this.disposables.push(
      webviewView.webview.onDidReceiveMessage((message: unknown) => this.handleMessage(message, webviewView))
    );

    // Drop our reference when the view is disposed so we don't post to a dead webview.
    this.disposables.push(
      webviewView.onDidDispose(() => {
        if (this.view === webviewView) this.view = undefined;
      })
    );

    // Send pending data if available
    if (this.pendingData) {
      this.updateData(this.pendingData, this.pendingBudgetState);
    }
  }

  /** Handle a (semi-trusted) message posted from the webview. */
  private async handleMessage(message: unknown, webviewView: vscode.WebviewView): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const command = (message as { command?: unknown }).command;
    if (typeof command !== 'string') return;

    switch (command) {
      case 'refresh':
        vscode.commands.executeCommand('copilotLiveCostTracker.refresh');
        break;
      case 'openSettings':
        vscode.commands.executeCommand('copilotLiveCostTracker.openSettings');
        break;
      case 'enableOtel':
        vscode.commands.executeCommand('copilotLiveCostTracker.enableOtel');
        break;
      case 'sessionDetail': {
        const sessionId = (message as { sessionId?: unknown }).sessionId;
        if (this.sessionDetailHandler && typeof sessionId === 'string' && sessionId.length > 0) {
          const detail = await this.sessionDetailHandler(sessionId);
          webviewView.webview.postMessage({ type: 'sessionDetail', sessionId, data: detail });
        }
        break;
      }
      case 'rangeSummary': {
        const preset = (message as { preset?: unknown }).preset;
        if (this.rangeSummaryHandler && (preset === '7d' || preset === '30d' || preset === '90d')) {
          const summary = await this.rangeSummaryHandler(preset);
          webviewView.webview.postMessage({ type: 'rangeSummary', summary });
        }
        break;
      }
    }
  }

  /** Push new dashboard data to the webview */
  updateData(data: DashboardData, budgetState: BudgetState | null): void {
    this.pendingData = data;
    this.pendingBudgetState = budgetState;

    if (this.view?.visible) {
      const currency = getDisplayCurrency();
      this.view.webview.postMessage({
        type: 'update',
        data,
        budgetState,
        displayCurrency: currency ?? null,
      });
    }
  }

  dispose(): void {
    for (const d of this.disposables.splice(0)) {
      d.dispose();
    }
    this.view = undefined;
  }

  private getHtml(): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root {
      --card-bg: var(--vscode-editor-background);
      --card-border: var(--vscode-panel-border);
      --text-primary: var(--vscode-foreground);
      --text-secondary: var(--vscode-descriptionForeground);
      --text-muted: var(--vscode-disabledForeground);
      --accent: var(--vscode-textLink-foreground);
      --cost-green: #4ec9b0;
      --cost-yellow: #dcdcaa;
      --cost-red: #f14c4c;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--text-primary);
      padding: 8px;
      line-height: 1.4;
    }

    .section {
      margin-bottom: 16px;
      padding: 12px;
      border: 1px solid var(--card-border);
      border-radius: 4px;
      background: var(--card-bg);
    }

    .section-header {
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
      margin-bottom: 8px;
      font-weight: 600;
    }

    .range-selector {
      display: flex;
      gap: 4px;
      margin-bottom: 8px;
    }

    .range-btn {
      flex: 1;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 0.8em;
      padding: 3px 6px;
      border-radius: 4px;
    }

    .range-btn:hover { color: var(--text-primary); }

    .range-btn.active {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--vscode-button-foreground, #fff);
      font-weight: 600;
    }

    .range-meta {
      font-size: 0.8em;
      color: var(--text-secondary);
      margin-top: 4px;
    }

    .cost-large {
      font-size: 1.8em;
      font-weight: 700;
      margin-bottom: 4px;
    }

    .cost-green { color: var(--cost-green); }
    .cost-yellow { color: var(--cost-yellow); }
    .cost-red { color: var(--cost-red); }

    .stat-row {
      display: flex;
      justify-content: space-between;
      padding: 2px 0;
      font-size: 0.85em;
    }

    .stat-label { color: var(--text-secondary); }
    .stat-value { font-weight: 500; }

    .model-table {
      width: 100%;
      font-size: 0.85em;
    }

    .model-row {
      display: flex;
      justify-content: space-between;
      padding: 3px 0;
      border-bottom: 1px solid var(--card-border);
    }

    .model-row:last-child { border-bottom: none; }
    .model-name { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; }
    .model-cost { font-weight: 500; white-space: nowrap; margin-left: 8px; }
    .est-badge {
      margin-left: 5px;
      padding: 0 4px;
      border-radius: 3px;
      font-size: 0.8em;
      color: var(--vscode-editorWarning-foreground, #cca700);
      border: 1px solid var(--vscode-editorWarning-foreground, #cca700);
      opacity: 0.85;
    }
    .unpriced-badge {
      margin-left: 5px;
      padding: 0 4px;
      border-radius: 3px;
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      border: 1px solid var(--vscode-descriptionForeground);
      opacity: 0.85;
    }
    /* Utility classes (avoid inline style attributes so CSP can forbid 'unsafe-inline') */
    .detail-msg { padding: 4px; color: var(--text-muted); }
    .session-title-row { margin-bottom: 6px; font-weight: 600; color: var(--vscode-foreground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-workspace { margin-bottom: 6px; font-size: 0.8em; color: var(--text-secondary); }
    .debug-block { margin-top: 8px; padding: 6px 8px; border: 1px dashed var(--vscode-panel-border, #555); border-radius: 4px; font-size: 11px; color: var(--text-muted); }
    .debug-title { font-weight: 600; margin-bottom: 4px; }
    .mono { font-family: var(--vscode-editor-font-family); }
    .indent-sub { padding-left: 2.4em; }

    .chart-svg {
      display: block;
      width: 100%;
      height: 70px;
    }

    .chart-container {
      display: flex;
      flex-direction: column;
    }

    .chart-labels {
      display: flex;
      justify-content: space-around;
      margin-top: 4px;
    }

    .chart-day-label {
      font-size: 9px;
      color: var(--text-muted);
      text-align: center;
      flex: 1;
    }

    .chart-bar-rect {
      fill: var(--vscode-charts-blue, var(--vscode-textLink-foreground, #3794ff));
    }

    .session-list { list-style: none; }

    .session-item {
      border-bottom: 1px solid var(--card-border);
    }

    .session-item:last-child { border-bottom: none; }

    .session-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      cursor: pointer;
    }

    .session-header:hover { opacity: 0.8; }

    .session-header .chevron {
      display: inline-block;
      font-size: 0.7em;
      margin-right: 4px;
      transition: transform 0.15s;
    }

    .session-item.expanded .chevron {
      transform: rotate(90deg);
    }

    .turn-chevron {
      display: inline-block;
      font-size: 0.7em;
      transition: transform 0.15s;
    }

    .turn-row:hover { background: var(--card-border); }

    .span-row td { color: var(--text-secondary); }

    .session-info {
      overflow: hidden;
    }

    .session-title {
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .session-meta {
      font-size: 0.75em;
      color: var(--text-secondary);
    }

    .session-repo {
      opacity: 0.85;
    }

    .session-cost {
      font-weight: 600;
      white-space: nowrap;
      margin-left: 8px;
    }

    .session-detail {
      display: none;
      padding: 8px 0 8px 12px;
      font-size: 0.8em;
    }

    .session-item.expanded .session-detail {
      display: block;
    }

    .session-detail .detail-section {
      margin-bottom: 8px;
    }

    .session-detail .detail-section-title {
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.4px;
      color: var(--text-secondary);
      margin-bottom: 4px;
      font-weight: 600;
    }

    .detail-table {
      width: 100%;
      border-collapse: separate;
      border-spacing: 0;
      font-size: 0.9em;
    }

    .detail-table th {
      text-align: left;
      font-weight: 600;
      padding: 2px 4px;
      border-bottom: 1px solid var(--card-border);
      color: var(--text-secondary);
      white-space: nowrap;
    }

    .detail-table td {
      padding: 2px 4px;
      white-space: nowrap;
    }

    .detail-table .num { text-align: right; }

    .hidden { display: none !important; }
    .clickable { cursor: pointer; }
    .span-row { display: none; opacity: 0.75; font-size: 0.9em; }
    .span-row.visible { display: table-row; }
    .span-row td:first-child { padding-left: 16px; }
    .subagent-row { cursor: pointer; opacity: 0.9; font-size: 0.95em; }
    .subagent-row td:first-child { padding-left: 1.2em; }
    .subagent-span-row { display: none; opacity: 0.7; font-size: 0.85em; }
    .subagent-span-row.visible { display: table-row; }
    .turn-row { cursor: pointer; }
    .turns-section-title { cursor: pointer; }
    .section-chevron, .turn-chevron {
      display: inline-block;
      transition: transform 0.15s;
    }
    .section-chevron.open, .turn-chevron.open {
      transform: rotate(90deg);
    }
    .turn-time {
      color: var(--text-secondary);
      font-size: 0.85em;
      margin-right: 2px;
    }
    .turn-agent {
      color: var(--accent);
      font-weight: 500;
    }
    .turn-label {
      color: var(--vscode-foreground);
      font-size: 0.9em;
      opacity: 0.9;
    }
    .turn-trace {
      color: var(--text-secondary);
      font-size: 0.9em;
    }
    .has-tip td:first-child {
      position: relative;
    }
    .has-tip:hover td:first-child {
      z-index: 1000;
    }
    .tip {
      display: none;
      position: absolute;
      left: 24px;
      top: 100%;
      z-index: 1000;
      background: var(--vscode-editorHoverWidget-background, var(--card-bg));
      color: var(--vscode-editorHoverWidget-foreground, var(--text-primary));
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--card-border));
      padding: 6px 10px;
      border-radius: 4px;
      font-size: 0.85em;
      line-height: 1.5;
      white-space: nowrap;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      pointer-events: none;
    }
    .has-tip:hover {
      position: relative;
      z-index: 1000;
    }
    .has-tip:hover .tip {
      display: block;
    }
    .detail-table {
      overflow: visible;
    }

    .toolbar {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
      justify-content: flex-end;
    }

    .toolbar button {
      background: none;
      border: none;
      color: var(--accent);
      cursor: pointer;
      font-size: 0.8em;
      text-decoration: underline;
    }

    .toolbar button:hover { opacity: 0.8; }

    .empty-state {
      text-align: center;
      padding: 24px;
      color: var(--text-muted);
    }

    .warning-banner {
      background: var(--vscode-inputValidation-warningBackground, #5a4a00);
      border: 1px solid var(--vscode-inputValidation-warningBorder, #b89500);
      border-radius: 4px;
      padding: 12px;
      margin-bottom: 12px;
    }

    .warning-banner-title {
      font-weight: 600;
      color: var(--vscode-inputValidation-warningForeground, #cca700);
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .warning-banner-message {
      font-size: 0.85em;
      white-space: pre-line;
      line-height: 1.5;
      color: var(--text-primary);
    }

    .warning-banner-link {
      display: inline-block;
      margin-top: 10px;
      margin-right: 14px;
      color: var(--accent);
      cursor: pointer;
      text-decoration: underline;
      font-size: 0.85em;
    }

    .warning-banner-link:hover {
      opacity: 0.8;
    }

    .updated-at {
      text-align: center;
      font-size: 0.7em;
      color: var(--text-muted);
      margin-top: 12px;
    }

    details.section-collapsible {
      margin-bottom: 16px;
      padding: 12px;
      border: 1px solid var(--card-border);
      border-radius: 4px;
      background: var(--card-bg);
    }

    details.section-collapsible > summary {
      list-style: none;
      display: flex;
      justify-content: space-between;
      align-items: center;
      cursor: pointer;
      user-select: none;
    }

    details.section-collapsible > summary::-webkit-details-marker {
      display: none;
    }

    details.section-collapsible[open] > summary {
      margin-bottom: 8px;
    }

    .section-title {
      font-size: 0.75em;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--text-secondary);
      font-weight: 600;
    }

    .section-summary-value {
      font-size: 0.8em;
      color: var(--text-secondary);
      font-weight: 500;
    }

    details.section-collapsible[open] .section-summary-value {
      display: none;
    }

    details.subsection {
      margin-top: 8px;
      border-top: 1px solid var(--card-border);
      padding-top: 6px;
    }

    details.subsection summary {
      font-size: 0.8em;
      color: var(--text-secondary);
      cursor: pointer;
      user-select: none;
      font-weight: 500;
      padding: 2px 0;
    }

    details.subsection summary:hover {
      color: var(--text-primary);
    }

    details.subsection .model-table,
    details.subsection .workspace-table {
      margin-top: 4px;
    }

    .workspace-table {
      width: 100%;
      font-size: 0.85em;
    }

    .workspace-row {
      display: flex;
      justify-content: space-between;
      padding: 3px 0;
      border-bottom: 1px solid var(--card-border);
    }

    .workspace-row:last-child { border-bottom: none; }
    .workspace-name { color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; }
    .workspace-cost { font-weight: 500; white-space: nowrap; margin-left: 8px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="btn-refresh">Refresh</button>
    <button id="btn-settings">Settings</button>
  </div>

  <div id="content">
    <div class="empty-state">Waiting for Copilot usage data...</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'refresh' });
    });
    document.getElementById('btn-settings').addEventListener('click', () => {
      vscode.postMessage({ command: 'openSettings' });
    });

    const sessionDetailCache = {};
    let displayCurrency = null;
    let lastData = null;
    let lastBudgetState = null;
    let selectedRange = '7d';
    let rangeSummary = null;

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'update') {
        displayCurrency = msg.displayCurrency || null;
        lastData = msg.data;
        lastBudgetState = msg.budgetState;
        render(msg.data, msg.budgetState);
        // Refresh the selected range summary alongside the live data.
        requestRange(selectedRange);
      } else if (msg.type === 'rangeSummary') {
        rangeSummary = msg.summary;
        updateRangeSection();
      } else if (msg.type === 'sessionDetail') {
        sessionDetailCache[msg.sessionId] = msg.data;
        renderSessionDetailInline(msg.sessionId, msg.data);
      }
    });

    function requestRange(preset) {
      selectedRange = preset;
      vscode.postMessage({ command: 'rangeSummary', preset: preset });
    }

    let expandedSessionId = null;
    const turnsExpandedSessions = {};
    const expandedTurnIds = {};
    const detailsOpenState = {}; // tracks open/closed state of <details> subsections by id

    function render(data, budgetState) {
      const content = document.getElementById('content');

      // Show warning banner when data source is unavailable
      let bannerHtml = '';
      if (data?.dataSourceStatus?.source === 'none') {
        bannerHtml = renderWarningBanner(data.dataSourceStatus.message);
      } else if (data?.dataSourceStatus?.source === 'debug-logs') {
        bannerHtml = renderWarningBanner(data.dataSourceStatus.message, true);
      }

      if (!data || (data.today.modelTurns === 0 && data.thisWeek.modelTurns === 0)) {
        content.innerHTML = bannerHtml + '<div class="empty-state">No Copilot usage data found yet.</div>';
        return;
      }

      var last7DaysTotal = (data.last7Days || []).reduce(function(s, d) { return s + (d.totalCost || 0); }, 0);
      const html = [
        bannerHtml,
        renderCollapsibleSection('today', 'TODAY', renderCostCard(data.today, budgetState?.dailyLevel) + renderCollapsibleModel('today-model', data.today.byModel) + renderCollapsibleWorkspace('today-ws', data.today.byWorkspace), formatCost(data.today.totalCost)),
        renderCollapsibleSection('currentSession', 'CURRENT SESSION', renderCurrentSessionCard(data.currentSession, budgetState?.sessionLevel), formatCost(data.currentSession.totalCost)),
        renderCollapsibleSection('recentSessions', 'RECENT SESSIONS', renderSessionList(data.recentSessions), (data.recentSessions ? data.recentSessions.length : 0) + ' sessions'),
        renderCollapsibleSection('thisWeek', 'THIS WEEK', renderCostCard(data.thisWeek, budgetState?.weeklyLevel) + renderCollapsibleModel('week-model', data.thisWeek.byModel) + renderCollapsibleWorkspace('week-ws', data.thisWeek.byWorkspace), formatCost(data.thisWeek.totalCost)),
        renderCollapsibleSection('dateRange', 'DATE RANGE', renderRangeSelector() + '<div id="range-body">' + renderRangeBody() + '</div>', RANGE_LABELS[selectedRange]),
        renderCollapsibleSection('last7days', 'LAST 7 DAYS', renderChart(data.last7Days), formatCost(last7DaysTotal)),
        '<div class="updated-at">Updated: ' + formatTime(data.updatedAt) + '</div>',
      ].join('');

      content.innerHTML = html;

      // Restore open state of collapsible <details> subsections
      document.querySelectorAll('details.subsection[id]').forEach(function(el) {
        if (detailsOpenState[el.id]) { el.open = true; }
      });
      // Track open/close changes
      document.querySelectorAll('details.subsection[id]').forEach(function(el) {
        el.addEventListener('toggle', function() { detailsOpenState[el.id] = el.open; });
      });
      // Restore collapsed state of top-level sections (default: open)
      document.querySelectorAll('details.section-collapsible[id]').forEach(function(el) {
        if (detailsOpenState[el.id] === false) { el.open = false; }
        el.addEventListener('toggle', function() { detailsOpenState[el.id] = el.open; });
      });

      // Restore expanded session after re-render
      if (expandedSessionId) {
        var item = document.querySelector('.session-item[data-session-id="' + expandedSessionId + '"]');
        if (item) {
          item.classList.add('expanded');
          // Always re-fetch so detail stays in sync with header
          delete sessionDetailCache[expandedSessionId];
          var detailEl = document.getElementById('detail-' + expandedSessionId);
          if (detailEl) {
            detailEl.innerHTML = '<div class="detail-msg">Refreshing...</div>';
          }
          vscode.postMessage({ command: 'sessionDetail', sessionId: expandedSessionId });
        }
      }
    }

    function renderWarningBanner(message, isMinor) {
      const title = isMinor ? 'Using Fallback Data Source' : 'Data Source Unavailable';
      const icon = isMinor ? '\u26a0\ufe0f' : '\u274c';
      const otelLink = isMinor ? '' :
        '<span class="warning-banner-link" data-action="enableOtel">Enable OpenTelemetry Tracing</span>';
      return '<div class="warning-banner">' +
        '<div class="warning-banner-title">' + icon + ' ' + escapeHtml(title) + '</div>' +
        '<div class="warning-banner-message">' + escapeHtml(message || '') + '</div>' +
        otelLink +
        '<span class="warning-banner-link" data-action="openSettings">Open Extension Settings</span>' +
        '</div>';
    }

    function renderSection(title, body) {
      return '<div class="section"><div class="section-header">' + title + '</div>' + body + '</div>';
    }

    function renderCollapsibleSection(id, title, body, summaryValue) {
      return '<details class="section-collapsible" id="section-' + id + '" open>' +
        '<summary>' +
        '<span class="section-title">' + title + '</span>' +
        (summaryValue ? '<span class="section-summary-value">' + escapeHtml(String(summaryValue)) + '</span>' : '') +
        '</summary>' +
        body +
        '</details>';
    }

    var RANGE_LABELS = { '7d': '7 Days', '30d': '30 Days', '90d': '90 Days' };

    function renderRangeSelector() {
      return '<div class="range-selector">' +
        ['7d', '30d', '90d'].map(function(p) {
          var cls = 'range-btn' + (p === selectedRange ? ' active' : '');
          return '<button class="' + cls + '" data-range="' + p + '">' + RANGE_LABELS[p] + '</button>';
        }).join('') + '</div>';
    }

    function renderRangeBody() {
      if (!rangeSummary || rangeSummary.preset !== selectedRange) {
        return '<div class="range-meta">Loading\u2026</div>';
      }
      var s = rangeSummary;
      var meta = s.daysWithData + ' of ' + s.days + ' days with data \u00b7 ' + s.startDate + ' \u2192 ' + s.endDate;
      return '<div class="cost-large cost-green"' + costTitle(s.totalCost) + '>' + formatCost(s.totalCost) + '</div>' +
        statRow('Model Turns', s.modelTurns) +
        statRow('Input Tokens', formatTokens(s.inputTokens)) +
        statRow('Output Tokens', formatTokens(s.outputTokens)) +
        statRow('Cached Tokens', formatTokens(s.cachedTokens)) +
        renderCollapsibleModel('range-model', s.byModel) +
        '<div class="range-meta">' + escapeHtml(meta) + '</div>';
    }

    function updateRangeSection() {
      var body = document.getElementById('range-body');
      if (body) { body.innerHTML = renderRangeBody(); }
      document.querySelectorAll('.range-btn').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-range') === selectedRange);
      });
    }

    function renderCostCard(period, level) {
      const colorClass = level === 'limit' ? 'cost-red' : level === 'warning' ? 'cost-yellow' : 'cost-green';
      return '<div class="cost-large ' + colorClass + '"' + costTitle(period.totalCost) + '>' + formatCost(period.totalCost) + '</div>' +
        statRow('Model Turns', period.modelTurns) +
        statRow('Input Tokens', formatTokens(period.inputTokens)) +
        statRow('Output Tokens', formatTokens(period.outputTokens)) +
        statRow('Cached Tokens', formatTokens(period.cachedTokens));
    }

    function renderCurrentSessionCard(period, level) {
      const sid = period.sessionId;
      const sidShort = sid ? (sid.length > 12 ? sid.slice(0, 8) + '…' + sid.slice(-4) : sid) : '(none)';
      const agent = period.agentName || '(unknown)';
      const latest = period.latestSpanTimeMs ? formatTime(new Date(period.latestSpanTimeMs).toISOString()) : '(none)';
      const spanCount = period.spanCount != null ? period.spanCount : 0;
      const title = period.title || (sid ? '(untitled)' : '(no active session)');
      const titleRow =
        '<div class="session-title-row" title="' + escapeHtml(period.title || '') + '">' +
          escapeHtml(title) +
        '</div>';
      const workspaceRow = period.workspace
        ? '<div class="session-workspace">' + escapeHtml(period.workspace) + '</div>'
        : '';
      const debugRows =
        '<div class="debug-block">' +
          '<div class="debug-title">Debug</div>' +
          statRow('Session ID', '<span title="' + escapeHtml(sid || '') + '" class="mono">' + escapeHtml(sidShort) + '</span>') +
          statRow('Agent', escapeHtml(agent)) +
          statRow('Matched Spans', spanCount) +
          statRow('Latest Activity', latest) +
        '</div>';
      return titleRow + workspaceRow + renderCostCard(period, level) + debugRows;
    }

    function escapeHtml(s) {
      const div = document.createElement('div');
      div.textContent = String(s == null ? '' : s);
      return div.innerHTML;
    }

    function renderCollapsibleModel(id, models) {
      if (!models || models.length === 0) return '';
      return '<details class="subsection" id="' + id + '"><summary>By Model (' + models.length + ')</summary>' +
        '<div class="model-table">' +
        models.map(function(m) {
          return '<div class="model-row"><span class="model-name">' + escapeHtml(shortModel(m.model)) +
            (m.estimated ? '<span class="est-badge" title="Estimated pricing — model not yet in the official table">~est</span>' : '') +
            (m.unpriced ? '<span class="unpriced-badge" title="No pricing found for this model — cost shown as $0 but is unknown">unpriced</span>' : '') +
            '</span><span class="model-cost"' + costTitle(m.totalCost) + '>' + formatCost(m.totalCost) + '</span></div>';
        }).join('') + '</div></details>';
    }

    function renderCollapsibleWorkspace(id, workspaces) {
      if (!workspaces || workspaces.length === 0) return '';
      return '<details class="subsection" id="' + id + '"><summary>By Workspace (' + workspaces.length + ')</summary>' +
        '<div class="workspace-table">' +
        workspaces.map(function(w) {
          return '<div class="workspace-row"><span class="workspace-name">' + escapeHtml(w.workspace) +
            '</span><span class="workspace-cost"' + costTitle(w.totalCost) + '>' + formatCost(w.totalCost) + '</span></div>';
        }).join('') + '</div></details>';
    }

    function renderChart(days) {
      if (!days || days.length === 0) return '<div class="empty-state">No data</div>';
      const costs = days.map(d => (Number.isFinite(d.totalCost) ? d.totalCost : 0));
      const totalCostSum = costs.reduce((a, b) => a + b, 0);
      const useCost = totalCostSum > 0;
      const values = useCost
        ? costs
        : days.map(d => (Number.isFinite(d.modelTurns) ? d.modelTurns : 0));
      const maxValue = Math.max.apply(null, values.concat([useCost ? 0.01 : 1]));

      // SVG for bars only (stretched to fill width), labels rendered as HTML below.
      const viewW = 200;
      const chartH = 70;
      const gap = 4;
      const n = days.length;
      const barW = (viewW - gap * (n - 1)) / n;

      const bars = days.map((d, i) => {
        const ratio = maxValue > 0 ? (values[i] / maxValue) : 0;
        const safeRatio = Number.isFinite(ratio) ? ratio : 0;
        const h = Math.max(Math.min(safeRatio * chartH, chartH), 1);
        const x = i * (barW + gap);
        const y = chartH - h;
        const tooltip = d.dayLabel + ': ' + formatCost(d.totalCost) + ' \u00b7 ' + d.modelTurns + ' turns';
        return '<rect class="chart-bar-rect" x="' + x + '" y="' + y +
          '" width="' + barW + '" height="' + h + '" rx="1.5">' +
          '<title>' + escapeHtml(tooltip) + '</title></rect>';
      }).join('');

      const labels = days.map(d =>
        '<span class="chart-day-label">' + escapeHtml(d.dayLabel) + '</span>'
      ).join('');

      return '<div class="chart-container">' +
        '<svg class="chart-svg" viewBox="0 0 ' + viewW + ' ' + chartH +
        '" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
        bars + '</svg>' +
        '<div class="chart-labels">' + labels + '</div>' +
        '</div>';
    }

    function renderSessionList(sessions) {
      if (!sessions || sessions.length === 0) return '<div class="empty-state">No sessions</div>';
      return '<ul class="session-list">' +
        sessions.slice(0, 10).map(s =>
          '<li class="session-item" data-session-id="' + escapeHtml(s.sessionId) + '">' +
          '<div class="session-header">' +
          '<div class="session-info"><div class="session-title">' +
          '<span class="chevron">&#9654;</span> ' + escapeHtml(s.title) + '</div><div class="session-meta">' +
          (s.workspace ? '<span class="session-repo">' + escapeHtml(s.workspace) + '</span> \\u00b7 ' : '') +
          (s.model ? escapeHtml(shortModel(s.model)) + ' \\u00b7 ' : '') + s.modelTurns + ' requests \\u00b7 ' + timeAgo(s.endedAt) +
          '</div></div><span class="session-cost"' + costTitle(s.totalCost) + '>' + formatCost(s.totalCost) + '</span></div>' +
          '<div class="session-detail" id="detail-' + escapeHtml(s.sessionId) + '"></div></li>'
        ).join('') + '</ul>';
    }

    // Event delegation for session header clicks (CSP blocks inline onclick)
    document.addEventListener('click', function(e) {
      // Warning banner "Open Extension Settings" link
      var settingsLink = e.target.closest('[data-action="openSettings"]');
      if (settingsLink) {
        vscode.postMessage({ command: 'openSettings' });
        return;
      }

      // Warning banner "Enable OpenTelemetry Tracing" link
      var otelLink = e.target.closest('[data-action="enableOtel"]');
      if (otelLink) {
        vscode.postMessage({ command: 'enableOtel' });
        return;
      }

      // Date-range selector buttons
      var rangeBtn = e.target.closest('.range-btn');
      if (rangeBtn) {
        var preset = rangeBtn.getAttribute('data-range');
        if (preset && preset !== selectedRange) {
          selectedRange = preset;
          rangeSummary = null;
          updateRangeSection();
          requestRange(preset);
        }
        return;
      }

      // Turns section title expand/collapse
      var turnsTitle = e.target.closest('.turns-section-title');
      if (turnsTitle) {
        var wrapperId = turnsTitle.getAttribute('data-wrapper');
        var wrapper = wrapperId && document.getElementById(wrapperId);
        var chevron = turnsTitle.querySelector('.section-chevron');
        if (wrapper) {
          var isHidden = wrapper.classList.contains('hidden');
          if (isHidden) {
            wrapper.classList.remove('hidden');
            if (chevron) chevron.classList.add('open');
            if (expandedSessionId) turnsExpandedSessions[expandedSessionId] = true;
          } else {
            wrapper.classList.add('hidden');
            if (chevron) chevron.classList.remove('open');
            if (expandedSessionId) delete turnsExpandedSessions[expandedSessionId];
          }
        }
        return;
      }

      // Turn row expand/collapse
      var turnRow = e.target.closest('.turn-row') || e.target.closest('.subagent-row');
      if (turnRow) {
        var turnId = turnRow.dataset.turnId;
        var isOpen = turnRow.classList.contains('expanded');
        // For top-level turn rows, collapse all other turn rows first
        if (turnRow.classList.contains('turn-row')) {
          document.querySelectorAll('.turn-row.expanded').forEach(function(tr) {
            tr.classList.remove('expanded');
            var chev = tr.querySelector('.turn-chevron');
            if (chev) chev.classList.remove('open');
            document.querySelectorAll('.span-row[data-parent="' + tr.dataset.turnId + '"]').forEach(function(sr) {
              sr.classList.remove('visible');
              // Also collapse any expanded subagent rows within
              if (sr.classList.contains('subagent-row') && sr.classList.contains('expanded')) {
                sr.classList.remove('expanded');
                var subChev = sr.querySelector('.turn-chevron');
                if (subChev) subChev.classList.remove('open');
                document.querySelectorAll('[data-parent="' + sr.dataset.turnId + '"]').forEach(function(ssr) {
                  ssr.classList.remove('visible');
                });
              }
            });
          });
        }
        if (!isOpen) {
          turnRow.classList.add('expanded');
          var chevron = turnRow.querySelector('.turn-chevron');
          if (chevron) chevron.classList.add('open');
          document.querySelectorAll('.span-row[data-parent="' + turnId + '"], .subagent-span-row[data-parent="' + turnId + '"]').forEach(function(sr) {
            sr.classList.add('visible');
          });
          if (expandedSessionId && turnRow.classList.contains('turn-row')) expandedTurnIds[expandedSessionId] = turnId;
        } else {
          turnRow.classList.remove('expanded');
          var chevClose = turnRow.querySelector('.turn-chevron');
          if (chevClose) chevClose.classList.remove('open');
          document.querySelectorAll('.span-row[data-parent="' + turnId + '"], .subagent-span-row[data-parent="' + turnId + '"]').forEach(function(sr) {
            sr.classList.remove('visible');
            // Collapse nested subagent rows too
            if (sr.classList.contains('subagent-row') && sr.classList.contains('expanded')) {
              sr.classList.remove('expanded');
              var subChev2 = sr.querySelector('.turn-chevron');
              if (subChev2) subChev2.classList.remove('open');
              document.querySelectorAll('[data-parent="' + sr.dataset.turnId + '"]').forEach(function(ssr) {
                ssr.classList.remove('visible');
              });
            }
          });
          if (expandedSessionId && turnRow.classList.contains('turn-row')) delete expandedTurnIds[expandedSessionId];
        }
        return;
      }

      const header = e.target.closest('.session-header');
      if (!header) return;
      const item = header.closest('.session-item');
      if (!item) return;
      const sessionId = item.dataset.sessionId;
      const wasExpanded = item.classList.contains('expanded');

      // Accordion: collapse all
      document.querySelectorAll('.session-item.expanded').forEach(function(el) {
        el.classList.remove('expanded');
      });

      if (!wasExpanded) {
        item.classList.add('expanded');
        expandedSessionId = sessionId;
        // Lazy fetch if not cached
        if (!sessionDetailCache[sessionId]) {
          var detailEl = document.getElementById('detail-' + sessionId);
          if (detailEl) {
            detailEl.innerHTML = '<div class="detail-msg">Loading...</div>';
          }
          vscode.postMessage({ command: 'sessionDetail', sessionId: sessionId });
        } else {
          renderSessionDetailInline(sessionId, sessionDetailCache[sessionId]);
        }
      } else {
        expandedSessionId = null;
      }
    });

    function renderSessionDetailInline(sessionId, data) {
      const detailEl = document.getElementById('detail-' + sessionId);
      if (!detailEl) return;

      if (!data) {
        detailEl.innerHTML = '<div class="detail-msg">Detailed data for this session is no longer available.</div>';
        return;
      }

      let html = '';

      // Historic sessions are reconstructed from saved history (no per-turn spans).
      if (data.historic) {
        html += '<div class="detail-msg">Per-prompt detail is not retained for older sessions. Showing the saved per-model summary.</div>';
      }

      // Per-model breakdown
      html += '<div class="detail-section"><div class="detail-section-title">LLM Requests by Model (' + data.totalLlmCalls + ' total)</div>';
      html += '<table class="detail-table"><tr><th>Model</th><th class="num">Requests</th><th class="num">Cost</th><th class="num">In</th><th class="num">Out</th><th class="num">Cache R</th><th class="num">Cache W</th><th class="num">Hit%</th><th class="num">tok/s</th></tr>';
      data.byModel.forEach(function(m) {
        html += '<tr><td>' + escapeHtml(shortModel(m.model)) + '</td>' +
          '<td class="num">' + m.calls + '</td>' +
          '<td class="num">' + formatCost(m.totalCost) + '</td>' +
          '<td class="num">' + formatTokens(m.inputTokens) + '</td>' +
          '<td class="num">' + formatTokens(m.outputTokens) + '</td>' +
          '<td class="num">' + formatTokens(m.cachedTokens) + '</td>' +
          '<td class="num">' + formatTokens(m.cacheWriteTokens) + '</td>' +
          '<td class="num">' + m.cacheHitPct + '%</td>' +
          '<td class="num">' + m.rateTokensPerSec + '</td></tr>';
      });
      html += '</table></div>';

      // Per-turn breakdown with expandable spans
      if (data.turns && data.turns.length > 0) {
        var turnsWrapperId = 'turns-wrap-' + sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
        var turnsOpen = !!turnsExpandedSessions[sessionId];
        html += '<div class="detail-section"><div class="detail-section-title turns-section-title" data-wrapper="' + turnsWrapperId + '"><span class="section-chevron' + (turnsOpen ? ' open' : '') + '">&#9654;</span> Cost per User Prompt (' + data.turns.length + ' prompts)</div>';
        html += '<div id="' + turnsWrapperId + '" class="' + (turnsOpen ? '' : 'hidden') + '"><table class="detail-table">';
        html += '<tr><th>Trace</th><th class="num">Requests</th><th class="num">Cost</th><th class="num">In</th><th class="num">Out</th><th class="num">Cache R</th><th class="num">Cache W</th><th class="num">Hit%</th></tr>';
        data.turns.forEach(function(t, idx) {
          var turnId = 'turn-spans-' + idx;
          var traceLabel = t.traceId ? t.traceId.slice(0, 8) : ('T' + t.turnIndex);
          var timeLabel = t.startTimeMs ? formatClock(t.startTimeMs) : '';
          var agentLabel = t.agentName ? escapeHtml(t.agentName) : '';
          var turnLabel = t.label ? escapeHtml(t.label) : '';
          var totalTokens = (t.inputTokens || 0) + (t.outputTokens || 0) + (t.cachedTokens || 0);
          var tipLines = [
            t.label ? 'Prompt: ' + t.label : '',
            t.agentName ? 'Agent: ' + t.agentName : '',
            t.model ? 'Model: ' + shortModel(t.model) : '',
            'Trace: ' + (t.traceId || ''),
            'Time: ' + (timeLabel || ''),
            'Duration: ' + formatDuration(t.durationMs),
            'Tokens: ' + formatTokens(totalTokens) + ' (in ' + formatTokens(t.inputTokens) + ' / out ' + formatTokens(t.outputTokens) + ' / cache ' + formatTokens(t.cachedTokens) + ')',
            'Cost: ' + formatCost(t.totalCost),
            'Requests: ' + t.llmCalls
          ].filter(Boolean);
          var tipHtml = tipLines.map(function(l) { return '<div>' + escapeHtml(l) + '</div>'; }).join('');
          html += '<tr class="turn-row has-tip" data-turn-id="' + turnId + '">' +
            '<td><span class="chevron turn-chevron">&#9654;</span> ' + (timeLabel ? '<span class="turn-time">[' + timeLabel + ']</span> ' : '') + (turnLabel ? '<span class="turn-label">' + turnLabel + '</span>' : (agentLabel ? '<span class="turn-agent">' + agentLabel + '</span> ' : '') + '<span class="turn-trace">' + traceLabel + '</span>') +
            '<span class="tip">' + tipHtml + '</span></td>' +
            '<td class="num">' + t.llmCalls + '</td>' +
            '<td class="num">' + formatCost(t.totalCost) + '</td>' +
            '<td class="num">' + formatTokens(t.inputTokens) + '</td>' +
            '<td class="num">' + formatTokens(t.outputTokens) + '</td>' +
            '<td class="num">' + formatTokens(t.cachedTokens) + '</td>' +
            '<td class="num">' + formatTokens(t.cacheWriteTokens) + '</td>' +
            '<td class="num">' + cacheHit(t.inputTokens, t.cachedTokens) + '</td></tr>';
          // Nested span rows (hidden via CSS .span-row)
          if (t.spans && t.spans.length > 0) {
            t.spans.forEach(function(sp, spIdx) {
              var spAgent = sp.agentName ? '<span class="turn-agent">' + escapeHtml(sp.agentName) + '</span> ' : '';
              var spTotal = (sp.inputTokens || 0) + (sp.outputTokens || 0) + (sp.cachedTokens || 0);
              var spTipLines = [
                sp.agentName ? 'Agent: ' + sp.agentName : '',
                'Model: ' + sp.model,
                'Trace: ' + (sp.traceId || ''),
                'Span: ' + (sp.spanId || ''),
                'Duration: ' + formatDuration(sp.durationMs),
                'Tokens: ' + formatTokens(spTotal) + ' (in ' + formatTokens(sp.inputTokens) + ' / out ' + formatTokens(sp.outputTokens) + ' / cache ' + formatTokens(sp.cachedTokens) + ')',
                'Cost: ' + formatCost(sp.totalCost)
              ].filter(Boolean);
              var spTipHtml = spTipLines.map(function(l) { return '<div>' + escapeHtml(l) + '</div>'; }).join('');
              html += '<tr class="span-row has-tip" data-parent="' + turnId + '">' +
                '<td>' + spAgent + escapeHtml(shortModel(sp.model)) + '<span class="tip">' + spTipHtml + '</span></td>' +
                '<td class="num">' + (spIdx + 1) + '</td>' +
                '<td class="num">' + formatCost(sp.totalCost) + '</td>' +
                '<td class="num">' + formatTokens(sp.inputTokens) + '</td>' +
                '<td class="num">' + formatTokens(sp.outputTokens) + '</td>' +
                '<td class="num">' + formatTokens(sp.cachedTokens) + '</td>' +
                '<td class="num">' + formatTokens(sp.cacheWriteTokens) + '</td>' +
                '<td class="num">' + cacheHit(sp.inputTokens, sp.cachedTokens) + '</td></tr>';
            });
          }
          // Subagent child turns (indented, shown as distinct labeled groups)
          if (t.children && t.children.length > 0) {
            t.children.forEach(function(child, childIdx) {
              var childId = turnId + '-child-' + childIdx;
              var childAgent = child.agentName ? escapeHtml(child.agentName) : 'subagent';
              var childTime = child.startTimeMs ? formatClock(child.startTimeMs) : '';
              var childTipLines = [
                child.agentName ? 'Agent: ' + child.agentName : '',
                child.model ? 'Model: ' + shortModel(child.model) : '',
                'Duration: ' + formatDuration(child.durationMs),
                'Turns: ' + child.llmCalls,
                'Cost: ' + formatCost(child.totalCost)
              ].filter(Boolean);
              var childTipHtml = childTipLines.map(function(l) { return '<div>' + escapeHtml(l) + '</div>'; }).join('');
              html += '<tr class="span-row subagent-row has-tip" data-parent="' + turnId + '" data-turn-id="' + childId + '">' +
                '<td><span class="chevron turn-chevron">&#9654;</span> ' + (childTime ? '<span class="turn-time">[' + childTime + ']</span> ' : '') + '<span class="turn-agent">' + childAgent + '</span>' +
                '<span class="tip">' + childTipHtml + '</span></td>' +
                '<td class="num">' + child.llmCalls + '</td>' +
                '<td class="num">' + formatCost(child.totalCost) + '</td>' +
                '<td class="num">' + formatTokens(child.inputTokens) + '</td>' +
                '<td class="num">' + formatTokens(child.outputTokens) + '</td>' +
                '<td class="num">' + formatTokens(child.cachedTokens) + '</td>' +
                '<td class="num">' + formatTokens(child.cacheWriteTokens) + '</td>' +
                '<td class="num">' + cacheHit(child.inputTokens, child.cachedTokens) + '</td></tr>';
              // Nested spans within the child subagent
              if (child.spans && child.spans.length > 0) {
                child.spans.forEach(function(csp, cspIdx) {
                  var cspAgent = csp.agentName ? '<span class="turn-agent">' + escapeHtml(csp.agentName) + '</span> ' : '';
                  var cspTotal = (csp.inputTokens || 0) + (csp.outputTokens || 0) + (csp.cachedTokens || 0);
                  var cspTipLines = [
                    csp.agentName ? 'Agent: ' + csp.agentName : '',
                    'Model: ' + csp.model,
                    'Trace: ' + (csp.traceId || ''),
                    'Span: ' + (csp.spanId || ''),
                    'Duration: ' + formatDuration(csp.durationMs),
                    'Tokens: ' + formatTokens(cspTotal) + ' (in ' + formatTokens(csp.inputTokens) + ' / out ' + formatTokens(csp.outputTokens) + ' / cache ' + formatTokens(csp.cachedTokens) + ')',
                    'Cost: ' + formatCost(csp.totalCost)
                  ].filter(Boolean);
                  var cspTipHtml = cspTipLines.map(function(l) { return '<div>' + escapeHtml(l) + '</div>'; }).join('');
                  html += '<tr class="span-row subagent-span-row has-tip" data-parent="' + childId + '">' +
                    '<td class="indent-sub">' + cspAgent + escapeHtml(shortModel(csp.model)) + '<span class="tip">' + cspTipHtml + '</span></td>' +
                    '<td class="num">' + (cspIdx + 1) + '</td>' +
                    '<td class="num">' + formatCost(csp.totalCost) + '</td>' +
                    '<td class="num">' + formatTokens(csp.inputTokens) + '</td>' +
                    '<td class="num">' + formatTokens(csp.outputTokens) + '</td>' +
                    '<td class="num">' + formatTokens(csp.cachedTokens) + '</td>' +
                    '<td class="num">' + formatTokens(csp.cacheWriteTokens) + '</td>' +
                    '<td class="num">' + cacheHit(csp.inputTokens, csp.cachedTokens) + '</td></tr>';
                });
              }
            });
          }
        });
        html += '</table></div></div>';
      }

      detailEl.innerHTML = html;

      // Restore turns section visibility from state
      var turnsWrapperId = 'turns-wrap-' + sessionId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 16);
      var turnsWrapper = document.getElementById(turnsWrapperId);
      if (turnsWrapper && turnsExpandedSessions[sessionId]) {
        turnsWrapper.classList.remove('hidden');
        var chevron = detailEl.querySelector('.turns-section-title .section-chevron');
        if (chevron) chevron.classList.add('open');
      }

      // Restore expanded turn row if any
      var savedTurnId = expandedTurnIds[sessionId];
      if (savedTurnId) {
        var turnRow = detailEl.querySelector('.turn-row[data-turn-id="' + savedTurnId + '"]');
        if (turnRow) {
          turnRow.classList.add('expanded');
          var chevron = turnRow.querySelector('.turn-chevron');
          if (chevron) chevron.classList.add('open');
          detailEl.querySelectorAll('.span-row[data-parent="' + savedTurnId + '"]').forEach(function(sr) {
            sr.classList.add('visible');
          });
        }
      }
    }

    function statRow(label, value) {
      return '<div class="stat-row"><span class="stat-label">' + label + '</span><span class="stat-value">' + value + '</span></div>';
    }

    function formatCost(cost) {
      if (cost < 0.001 && cost > 0) return '< $0.001';
      return '$' + cost.toFixed(3);
    }

    function costTitle(cost) {
      if (!displayCurrency) return '';
      return ' title="~' + (cost * displayCurrency.rate).toFixed(3) + ' ' + displayCurrency.code + '"';
    }

    function formatTokens(count) {
      if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
      if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
      return '' + count;
    }

    function cacheHit(inputTokens, cachedTokens) {
      return (inputTokens > 0 ? Math.round(100 * cachedTokens / inputTokens) : 0) + '%';
    }

    function shortModel(model) {
      return model.replace(/-\\d{8}$/, '').replace(/-\\d{4}-\\d{2}-\\d{2}$/, '');
    }

    function timeAgo(ms) {
      const diff = Date.now() - ms;
      const mins = Math.floor(diff / 60000);
      if (mins < 1) return 'just now';
      if (mins < 60) return mins + ' min ago';
      const hours = Math.floor(mins / 60);
      if (hours < 24) return hours + ' hour' + (hours > 1 ? 's' : '') + ' ago';
      const days = Math.floor(hours / 24);
      return days + ' day' + (days > 1 ? 's' : '') + ' ago';
    }

    function formatTime(iso) {
      return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatClock(ms) {
      return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function formatDuration(ms) {
      if (!ms || ms < 0) return '0ms';
      if (ms < 1000) return Math.round(ms) + 'ms';
      if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
      const m = Math.floor(ms / 60000);
      const s = Math.round((ms % 60000) / 1000);
      return m + 'm ' + s + 's';
    }
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  // Use a cryptographically secure RNG so the CSP nonce is unpredictable.
  return randomBytes(16).toString('base64');
}
