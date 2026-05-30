import * as vscode from 'vscode';
import type { DashboardData, BudgetState, SessionDetailData } from '../domain/models.js';

/**
 * SidebarWebviewProvider renders the cost dashboard in the activity bar sidebar.
 * Communicates with the webview via postMessage for updates.
 */
export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'copilotCostTracker.dashboard';

  private view: vscode.WebviewView | undefined;
  private pendingData: DashboardData | null = null;
  private pendingBudgetState: BudgetState | null = null;
  private sessionDetailHandler: ((sessionId: string) => Promise<SessionDetailData | null>) | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Set the handler called when the webview requests session detail */
  setSessionDetailHandler(handler: (sessionId: string) => Promise<SessionDetailData | null>): void {
    this.sessionDetailHandler = handler;
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

    webviewView.webview.html = this.getHtml(webviewView.webview);

    // Handle messages from webview
    webviewView.webview.onDidReceiveMessage(async (message) => {
      switch (message.command) {
        case 'refresh':
          vscode.commands.executeCommand('copilotCostTracker.refresh');
          break;
        case 'openSettings':
          vscode.commands.executeCommand('copilotCostTracker.openSettings');
          break;
        case 'sessionDetail':
          if (this.sessionDetailHandler && message.sessionId) {
            const detail = await this.sessionDetailHandler(message.sessionId);
            webviewView.webview.postMessage({
              type: 'sessionDetail',
              sessionId: message.sessionId,
              data: detail,
            });
          }
          break;
      }
    });

    // Send pending data if available
    if (this.pendingData) {
      this.updateData(this.pendingData, this.pendingBudgetState);
    }
  }

  /** Push new dashboard data to the webview */
  updateData(data: DashboardData, budgetState: BudgetState | null): void {
    this.pendingData = data;
    this.pendingBudgetState = budgetState;

    if (this.view?.visible) {
      this.view.webview.postMessage({
        type: 'update',
        data,
        budgetState,
      });
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}' 'unsafe-inline'; script-src 'nonce-${nonce}';">
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

    .chart-svg {
      display: block;
      width: 100%;
      height: 90px;
    }

    .chart-bar-rect {
      fill: var(--vscode-charts-blue, var(--vscode-textLink-foreground, #3794ff));
    }

    .chart-bar-label {
      font-size: 9px;
      fill: var(--text-muted);
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
      opacity: 0.8;
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

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'update') {
        render(msg.data, msg.budgetState);
      } else if (msg.type === 'sessionDetail') {
        if (msg.data) {
          sessionDetailCache[msg.sessionId] = msg.data;
          renderSessionDetailInline(msg.sessionId, msg.data);
        }
      }
    });

    let expandedSessionId = null;
    const turnsExpandedSessions = {};
    const expandedTurnIds = {};

    function render(data, budgetState) {
      const content = document.getElementById('content');

      // Show warning banner when data source is unavailable
      let bannerHtml = '';
      if (data?.dataSourceStatus?.source === 'none') {
        bannerHtml = renderWarningBanner(data.dataSourceStatus.message);
      } else if (data?.dataSourceStatus?.source === 'debug-logs') {
        bannerHtml = renderWarningBanner(data.dataSourceStatus.message, true);
      }

      if (!data || (data.today.requests === 0 && data.thisWeek.requests === 0)) {
        content.innerHTML = bannerHtml + '<div class="empty-state">No Copilot usage data found yet.</div>';
        return;
      }

      const html = [
        bannerHtml,
        renderSection('TODAY', renderCostCard(data.today, budgetState?.dailyLevel)),
        renderSection('THIS WEEK', renderWeekCard(data.thisWeek)),
        renderSection('TODAY BY MODEL', renderModelTable(data.today.byModel)),
        renderSection('CURRENT SESSION', renderCurrentSessionCard(data.currentSession, budgetState?.sessionLevel)),
        renderSection('LAST 7 DAYS', renderChart(data.last7Days)),
        renderSection('RECENT SESSIONS', renderSessionList(data.recentSessions)),
        '<div class="updated-at">Updated: ' + formatTime(data.updatedAt) + '</div>',
      ].join('');

      content.innerHTML = html;

      // Restore expanded session after re-render
      if (expandedSessionId) {
        var item = document.querySelector('.session-item[data-session-id="' + expandedSessionId + '"]');
        if (item) {
          item.classList.add('expanded');
          // Always re-fetch so detail stays in sync with header
          delete sessionDetailCache[expandedSessionId];
          var detailEl = document.getElementById('detail-' + expandedSessionId);
          if (detailEl) {
            detailEl.innerHTML = '<div style="padding:4px;color:var(--text-muted)">Refreshing...</div>';
          }
          vscode.postMessage({ command: 'sessionDetail', sessionId: expandedSessionId });
        }
      }
    }

    function renderWarningBanner(message, isMinor) {
      const title = isMinor ? 'Using Fallback Data Source' : 'Data Source Unavailable';
      const icon = isMinor ? '\u26a0\ufe0f' : '\u274c';
      return '<div class="warning-banner">' +
        '<div class="warning-banner-title">' + icon + ' ' + escapeHtml(title) + '</div>' +
        '<div class="warning-banner-message">' + escapeHtml(message || '') + '</div>' +
        '<span class="warning-banner-link" onclick="vscode.postMessage({ command: \\'openSettings\\' })">Open Extension Settings</span>' +
        '</div>';
    }

    function renderSection(title, body) {
      return '<div class="section"><div class="section-header">' + title + '</div>' + body + '</div>';
    }

    function renderCostCard(period, level) {
      const colorClass = level === 'limit' ? 'cost-red' : level === 'warning' ? 'cost-yellow' : 'cost-green';
      return '<div class="cost-large ' + colorClass + '">' + formatCost(period.totalCost) + '</div>' +
        statRow('Requests', period.requests) +
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
        '<div class="session-title-row" style="margin-bottom:6px;font-weight:600;color:var(--vscode-foreground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeHtml(period.title || '') + '">' +
          escapeHtml(title) +
        '</div>';
      const debugRows =
        '<div class="debug-block" style="margin-top:8px;padding:6px 8px;border:1px dashed var(--vscode-panel-border, #555);border-radius:4px;font-size:11px;color:var(--text-muted);">' +
          '<div style="font-weight:600;margin-bottom:4px;">Debug</div>' +
          statRow('Session ID', '<span title="' + escapeHtml(sid || '') + '" style="font-family:var(--vscode-editor-font-family);">' + escapeHtml(sidShort) + '</span>') +
          statRow('Agent', escapeHtml(agent)) +
          statRow('Matched Spans', spanCount) +
          statRow('Latest Activity', latest) +
        '</div>';
      return titleRow + renderCostCard(period, level) + debugRows;
    }

    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }

    function renderWeekCard(period) {
      return '<div class="cost-large cost-green">' + formatCost(period.totalCost) + '</div>' +
        statRow('Requests', period.requests);
    }

    function renderModelTable(models) {
      if (!models || models.length === 0) return '<div class="empty-state">No model data</div>';
      return '<div class="model-table">' +
        models.map(m =>
          '<div class="model-row"><span class="model-name">' + shortModel(m.model) +
          '</span><span class="model-cost">' + formatCost(m.totalCost) + '</span></div>'
        ).join('') + '</div>';
    }

    function renderChart(days) {
      if (!days || days.length === 0) return '<div class="empty-state">No data</div>';
      const costs = days.map(d => (Number.isFinite(d.totalCost) ? d.totalCost : 0));
      const totalCostSum = costs.reduce((a, b) => a + b, 0);
      const useCost = totalCostSum > 0;
      const values = useCost
        ? costs
        : days.map(d => (Number.isFinite(d.requests) ? d.requests : 0));
      const maxValue = Math.max.apply(null, values.concat([useCost ? 0.01 : 1]));

      // SVG-based chart: bulletproof rendering, no flex/percentage-height pitfalls.
      const viewW = 200;
      const viewH = 90;
      const labelH = 14;
      const chartH = viewH - labelH;
      const gap = 4;
      const n = days.length;
      const barW = (viewW - gap * (n - 1)) / n;

      const bars = days.map((d, i) => {
        const ratio = maxValue > 0 ? (values[i] / maxValue) : 0;
        const safeRatio = Number.isFinite(ratio) ? ratio : 0;
        const h = Math.max(Math.min(safeRatio * chartH, chartH), 1);
        const x = i * (barW + gap);
        const y = chartH - h;
        const labelX = x + barW / 2;
        const labelY = viewH - 3;
        const tooltip = d.dayLabel + ': ' + formatCost(d.totalCost) + ' \u00b7 ' + d.requests + ' calls';
        return '<rect class="chart-bar-rect" x="' + x + '" y="' + y +
          '" width="' + barW + '" height="' + h + '" rx="1.5">' +
          '<title>' + escapeHtml(tooltip) + '</title></rect>' +
          '<text class="chart-bar-label" x="' + labelX + '" y="' + labelY +
          '" text-anchor="middle">' + escapeHtml(d.dayLabel) + '</text>';
      }).join('');

      return '<svg class="chart-svg" viewBox="0 0 ' + viewW + ' ' + viewH +
        '" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
        bars + '</svg>';
    }

    function renderSessionList(sessions) {
      if (!sessions || sessions.length === 0) return '<div class="empty-state">No sessions</div>';
      return '<ul class="session-list">' +
        sessions.slice(0, 10).map(s =>
          '<li class="session-item" data-session-id="' + escapeHtml(s.sessionId) + '">' +
          '<div class="session-header">' +
          '<div class="session-info"><div class="session-title">' +
          '<span class="chevron">&#9654;</span> ' + escapeHtml(s.title) + '</div><div class="session-meta">' +
          (s.repository ? '<span class="session-repo">' + escapeHtml(s.repository) + '</span> \\u00b7 ' : '') +
          (s.model ? shortModel(s.model) + ' \\u00b7 ' : '') + s.requests + ' calls \\u00b7 ' + timeAgo(s.endedAt) +
          '</div></div><span class="session-cost">' + formatCost(s.totalCost) + '</span></div>' +
          '<div class="session-detail" id="detail-' + escapeHtml(s.sessionId) + '"></div></li>'
        ).join('') + '</ul>';
    }

    // Event delegation for session header clicks (CSP blocks inline onclick)
    document.addEventListener('click', function(e) {
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
      var turnRow = e.target.closest('.turn-row');
      if (turnRow) {
        var turnId = turnRow.dataset.turnId;
        var isOpen = turnRow.classList.contains('expanded');
        // Collapse all turn rows first
        document.querySelectorAll('.turn-row.expanded').forEach(function(tr) {
          tr.classList.remove('expanded');
          var chev = tr.querySelector('.turn-chevron');
          if (chev) chev.classList.remove('open');
          document.querySelectorAll('.span-row[data-parent="' + tr.dataset.turnId + '"]').forEach(function(sr) {
            sr.classList.remove('visible');
          });
        });
        if (!isOpen) {
          turnRow.classList.add('expanded');
          var chevron = turnRow.querySelector('.turn-chevron');
          if (chevron) chevron.classList.add('open');
          document.querySelectorAll('.span-row[data-parent="' + turnId + '"]').forEach(function(sr) {
            sr.classList.add('visible');
          });
          if (expandedSessionId) expandedTurnIds[expandedSessionId] = turnId;
        } else {
          if (expandedSessionId) delete expandedTurnIds[expandedSessionId];
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
            detailEl.innerHTML = '<div style="padding:4px;color:var(--text-muted)">Loading...</div>';
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

      let html = '';

      // Per-model breakdown
      html += '<div class="detail-section"><div class="detail-section-title">LLM Calls by Model (' + data.totalLlmCalls + ' total)</div>';
      html += '<table class="detail-table"><tr><th>Model</th><th class="num">Calls</th><th class="num">Cost</th><th class="num">In</th><th class="num">Out</th><th class="num">Cache R</th><th class="num">Cache W</th><th class="num">Hit%</th><th class="num">tok/s</th></tr>';
      data.byModel.forEach(function(m) {
        html += '<tr><td>' + shortModel(m.model) + '</td>' +
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
        html += '<div class="detail-section"><div class="detail-section-title turns-section-title" data-wrapper="' + turnsWrapperId + '"><span class="section-chevron' + (turnsOpen ? ' open' : '') + '">&#9654;</span> Cost per Turn (' + data.turns.length + ' turns)</div>';
        html += '<div id="' + turnsWrapperId + '" class="' + (turnsOpen ? '' : 'hidden') + '"><table class="detail-table">';
        html += '<tr><th>Trace</th><th class="num">Calls</th><th class="num">Cost</th><th class="num">In</th><th class="num">Out</th><th class="num">Cache R</th><th class="num">Cache W</th></tr>';
        data.turns.forEach(function(t, idx) {
          var turnId = 'turn-spans-' + idx;
          var traceLabel = t.traceId ? t.traceId.slice(0, 8) : ('T' + t.turnIndex);
          var timeLabel = t.startTimeMs ? formatClock(t.startTimeMs) : '';
          var agentLabel = t.agentName ? escapeHtml(t.agentName) : '';
          var totalTokens = (t.inputTokens || 0) + (t.outputTokens || 0) + (t.cachedTokens || 0);
          var tipLines = [
            t.agentName ? 'Agent: ' + t.agentName : '',
            t.model ? 'Model: ' + shortModel(t.model) : '',
            'Trace: ' + (t.traceId || ''),
            'Time: ' + (timeLabel || ''),
            'Duration: ' + formatDuration(t.durationMs),
            'Tokens: ' + formatTokens(totalTokens) + ' (in ' + formatTokens(t.inputTokens) + ' / out ' + formatTokens(t.outputTokens) + ' / cache ' + formatTokens(t.cachedTokens) + ')',
            'Cost: ' + formatCost(t.totalCost),
            'Calls: ' + t.llmCalls
          ].filter(Boolean);
          var tipHtml = tipLines.map(function(l) { return '<div>' + escapeHtml(l) + '</div>'; }).join('');
          html += '<tr class="turn-row has-tip" data-turn-id="' + turnId + '">' +
            '<td><span class="chevron turn-chevron">&#9654;</span> ' + (timeLabel ? '<span class="turn-time">[' + timeLabel + ']</span> ' : '') + (agentLabel ? '<span class="turn-agent">' + agentLabel + '</span> ' : '') + '<span class="turn-trace">' + traceLabel + '</span>' +
            '<span class="tip">' + tipHtml + '</span></td>' +
            '<td class="num">' + t.llmCalls + '</td>' +
            '<td class="num">' + formatCost(t.totalCost) + '</td>' +
            '<td class="num">' + formatTokens(t.inputTokens) + '</td>' +
            '<td class="num">' + formatTokens(t.outputTokens) + '</td>' +
            '<td class="num">' + formatTokens(t.cachedTokens) + '</td>' +
            '<td class="num">' + formatTokens(t.cacheWriteTokens) + '</td></tr>';
          // Nested span rows (hidden via CSS .span-row)
          if (t.spans && t.spans.length > 0) {
            t.spans.forEach(function(sp, spIdx) {
              var spAgent = sp.agentName ? '<span class="turn-agent">' + escapeHtml(sp.agentName) + '</span> ' : '';
              var spTotal = (sp.inputTokens || 0) + (sp.outputTokens || 0) + (sp.cachedTokens || 0);
              var spTipLines = [
                sp.agentName ? 'Agent: ' + sp.agentName : '',
                'Model: ' + sp.model,
                'Trace: ' + (sp.traceId || ''),
                'Duration: ' + formatDuration(sp.durationMs),
                'Tokens: ' + formatTokens(spTotal) + ' (in ' + formatTokens(sp.inputTokens) + ' / out ' + formatTokens(sp.outputTokens) + ' / cache ' + formatTokens(sp.cachedTokens) + ')',
                'Cost: ' + formatCost(sp.totalCost)
              ].filter(Boolean);
              var spTipHtml = spTipLines.map(function(l) { return '<div>' + escapeHtml(l) + '</div>'; }).join('');
              html += '<tr class="span-row has-tip" data-parent="' + turnId + '">' +
                '<td>' + spAgent + shortModel(sp.model) + '<span class="tip">' + spTipHtml + '</span></td>' +
                '<td class="num">' + (spIdx + 1) + '</td>' +
                '<td class="num">' + formatCost(sp.totalCost) + '</td>' +
                '<td class="num">' + formatTokens(sp.inputTokens) + '</td>' +
                '<td class="num">' + formatTokens(sp.outputTokens) + '</td>' +
                '<td class="num">' + formatTokens(sp.cachedTokens) + '</td>' +
                '<td class="num">' + formatTokens(sp.cacheWriteTokens) + '</td></tr>';
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
      if (cost < 0.01 && cost > 0) return '< $0.01';
      return '$' + cost.toFixed(2);
    }

    function formatTokens(count) {
      if (count >= 1000000) return (count / 1000000).toFixed(1) + 'M';
      if (count >= 1000) return (count / 1000).toFixed(1) + 'K';
      return '' + count;
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

    function escapeHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
