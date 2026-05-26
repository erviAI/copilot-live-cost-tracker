import * as vscode from 'vscode';
import type { DashboardData, BudgetState } from '../domain/models.js';

/**
 * SidebarWebviewProvider renders the cost dashboard in the activity bar sidebar.
 * Communicates with the webview via postMessage for updates.
 */
export class SidebarWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'copilotCostTracker.dashboard';

  private view: vscode.WebviewView | undefined;
  private pendingData: DashboardData | null = null;
  private pendingBudgetState: BudgetState | null = null;

  constructor(private readonly extensionUri: vscode.Uri) {}

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
    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message.command) {
        case 'refresh':
          vscode.commands.executeCommand('copilotCostTracker.refresh');
          break;
        case 'openSettings':
          vscode.commands.executeCommand('copilotCostTracker.openSettings');
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

    .chart-container {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      height: 60px;
      padding-top: 8px;
    }

    .chart-bar-wrapper {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
    }

    .chart-bar {
      width: 100%;
      background: var(--accent);
      border-radius: 2px 2px 0 0;
      min-height: 2px;
      margin-top: auto;
    }

    .chart-label {
      font-size: 0.65em;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .session-list { list-style: none; }

    .session-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 0;
      border-bottom: 1px solid var(--card-border);
    }

    .session-item:last-child { border-bottom: none; }

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

    .session-cost {
      font-weight: 600;
      white-space: nowrap;
      margin-left: 8px;
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

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'update') {
        render(msg.data, msg.budgetState);
      }
    });

    function render(data, budgetState) {
      const content = document.getElementById('content');
      if (!data || (data.today.requests === 0 && data.thisWeek.requests === 0)) {
        content.innerHTML = '<div class="empty-state">No Copilot usage data found yet.</div>';
        return;
      }

      const html = [
        renderSection('TODAY', renderCostCard(data.today, budgetState?.dailyLevel)),
        renderSection('THIS WEEK', renderWeekCard(data.thisWeek)),
        renderSection('TODAY BY MODEL', renderModelTable(data.today.byModel)),
        renderSection('CURRENT SESSION', renderCostCard(data.currentSession, budgetState?.sessionLevel)),
        renderSection('LAST 7 DAYS', renderChart(data.last7Days)),
        renderSection('RECENT SESSIONS', renderSessionList(data.recentSessions)),
        '<div class="updated-at">Updated: ' + formatTime(data.updatedAt) + '</div>',
      ].join('');

      content.innerHTML = html;
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
      const maxCost = Math.max(...days.map(d => d.totalCost), 0.01);
      return '<div class="chart-container">' +
        days.map(d => {
          const pct = Math.max((d.totalCost / maxCost) * 100, 2);
          return '<div class="chart-bar-wrapper">' +
            '<div class="chart-bar" style="height:' + pct + '%"></div>' +
            '<span class="chart-label">' + d.dayLabel + '</span></div>';
        }).join('') + '</div>';
    }

    function renderSessionList(sessions) {
      if (!sessions || sessions.length === 0) return '<div class="empty-state">No sessions</div>';
      return '<ul class="session-list">' +
        sessions.slice(0, 10).map(s =>
          '<li class="session-item"><div class="session-info"><div class="session-title">' +
          escapeHtml(s.title) + '</div><div class="session-meta">' +
          (s.model ? shortModel(s.model) + ' • ' : '') + timeAgo(s.endedAt) +
          '</div></div><span class="session-cost">' + formatCost(s.totalCost) + '</span></li>'
        ).join('') + '</ul>';
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
