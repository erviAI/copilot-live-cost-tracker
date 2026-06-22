import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { DashboardData, BudgetState, RangePreset, RangeSummary } from '../domain/models.js';
import { getBudgetThresholds, getDisplayCurrency } from '../config.js';

/**
 * DashboardPanel manages a full-window WebviewPanel showing a multi-tab,
 * Chart.js-powered dashboard. A single panel instance is reused (revealed)
 * across openDashboard invocations.
 */
export class DashboardPanel {
  public static readonly viewType = 'copilotLiveCostTracker.dashboardPanel';
  private static current: DashboardPanel | undefined;

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];

  private latestData: DashboardData | null = null;
  private latestBudgetState: BudgetState | null = null;
  private rangeSummaryHandler: ((preset: RangePreset) => Promise<RangeSummary>) | null = null;

  private constructor(panel: vscode.WebviewPanel, private readonly extensionUri: vscode.Uri) {
    this.panel = panel;
    this.panel.webview.html = this.getHtml(this.panel.webview);

    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((msg: unknown) => this.handleMessage(msg))
    );
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
  }

  /** Create the panel or reveal the existing one. */
  static createOrShow(extensionUri: vscode.Uri): DashboardPanel {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal(column);
      return DashboardPanel.current;
    }

    const panel = vscode.window.createWebviewPanel(
      DashboardPanel.viewType,
      'Copilot Cost Dashboard',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist')],
      }
    );

    DashboardPanel.current = new DashboardPanel(panel, extensionUri);
    return DashboardPanel.current;
  }

  /** True when a panel is currently open. */
  static get isOpen(): boolean {
    return DashboardPanel.current !== undefined;
  }

  /** Update the open panel (if any) without revealing/focusing it. */
  static updateIfOpen(data: DashboardData, budgetState: BudgetState | null): void {
    DashboardPanel.current?.update(data, budgetState);
  }

  /** Set the handler invoked when the webview requests a date-range summary. */
  setRangeSummaryHandler(handler: (preset: RangePreset) => Promise<RangeSummary>): void {
    this.rangeSummaryHandler = handler;
  }

  /** Push new dashboard data to the panel. */
  update(data: DashboardData, budgetState: BudgetState | null): void {
    this.latestData = data;
    this.latestBudgetState = budgetState;
    this.post();
  }

  private post(): void {
    if (!this.latestData) return;
    this.panel.webview.postMessage({
      type: 'update',
      data: this.latestData,
      budgetState: this.latestBudgetState,
      thresholds: getBudgetThresholds(),
      displayCurrency: getDisplayCurrency() ?? null,
    });
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return;
    const command = (message as { command?: unknown }).command;
    if (typeof command !== 'string') return;

    switch (command) {
      case 'ready':
        this.post();
        break;
      case 'refresh':
        vscode.commands.executeCommand('copilotLiveCostTracker.refresh');
        break;
      case 'openSettings':
        vscode.commands.executeCommand('copilotLiveCostTracker.openSettings');
        break;
      case 'rangeSummary': {
        const preset = (message as { preset?: unknown }).preset;
        if (this.rangeSummaryHandler && (preset === '7d' || preset === '30d' || preset === '90d')) {
          const summary = await this.rangeSummaryHandler(preset);
          this.panel.webview.postMessage({ type: 'rangeSummary', summary });
        }
        break;
      }
    }
  }

  dispose(): void {
    DashboardPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'dashboard.js')
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Copilot Cost Dashboard</title>
  <style>
    :root {
      --text-primary: var(--vscode-foreground);
      --text-secondary: var(--vscode-descriptionForeground);
      --card-bg: var(--vscode-editorWidget-background);
      --card-border: var(--vscode-widget-border, rgba(127,127,127,0.25));
      --accent: var(--vscode-textLink-foreground);
      --cost-green: #4e9a06;
      --cost-yellow: #e5a50a;
      --cost-red: #c01c28;
    }
    * { box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family);
      color: var(--text-primary);
      padding: 16px;
      margin: 0;
    }
    .header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    .header h1 { font-size: 1.1em; margin: 0; flex: 1; }
    .toolbar-btn {
      background: none; border: none; color: var(--accent);
      cursor: pointer; font-size: 0.85em; text-decoration: underline;
    }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--card-border); margin-bottom: 12px; }
    .tab {
      background: none; border: none; color: var(--text-secondary);
      cursor: pointer; padding: 8px 14px; font-size: 0.9em;
      border-bottom: 2px solid transparent;
    }
    .tab:hover { color: var(--text-primary); }
    .tab.active { color: var(--text-primary); border-bottom-color: var(--accent); font-weight: 600; }
    .range-selector { display: flex; gap: 4px; margin-bottom: 12px; }
    .range-btn {
      background: var(--card-bg); border: 1px solid var(--card-border);
      color: var(--text-secondary); cursor: pointer; font-size: 0.8em;
      padding: 4px 10px; border-radius: 4px;
    }
    .range-btn:hover { color: var(--text-primary); }
    .range-btn.active {
      background: var(--accent); border-color: var(--accent);
      color: var(--vscode-button-foreground, #fff); font-weight: 600;
    }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 12px; }
    .card-label { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); }
    .card-value { font-size: 1.6em; font-weight: 700; margin-top: 4px; }
    .card-sub { font-size: 0.78em; color: var(--text-secondary); margin-top: 2px; }
    .chart-wrap { position: relative; height: 260px; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 12px; }
    .chart-wrap.small { height: 220px; max-width: 320px; margin: 0 auto 16px; }
    .model-table { margin-top: 12px; }
    .model-row { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--card-border); }
    .model-row:last-child { border-bottom: none; }
    .dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
    .model-name { flex: 1; font-size: 0.88em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .model-cost { font-weight: 600; white-space: nowrap; }
    .budget { margin-bottom: 18px; }
    .budget-head { display: flex; justify-content: space-between; font-size: 0.9em; margin-bottom: 4px; }
    .budget-track { height: 10px; border-radius: 5px; background: var(--card-border); overflow: hidden; }
    .budget-fill { height: 100%; border-radius: 5px; transition: width 0.3s; }
    .budget-sub { font-size: 0.75em; color: var(--text-secondary); margin-top: 3px; }
    .empty { text-align: center; color: var(--text-secondary); padding: 48px 16px; }
    .updated-at { margin-top: 16px; font-size: 0.75em; color: var(--text-secondary); text-align: right; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Copilot Cost Dashboard</h1>
    <button class="toolbar-btn" id="btn-refresh">Refresh</button>
    <button class="toolbar-btn" id="btn-settings">Settings</button>
  </div>
  <div class="tabs">
    <button class="tab active" data-tab="overview">Overview</button>
    <button class="tab" data-tab="activity">Activity</button>
    <button class="tab" data-tab="models">Models</button>
    <button class="tab" data-tab="budget">Budget</button>
  </div>
  <div class="range-selector">
    <button class="range-btn active" data-range="7d">7 Days</button>
    <button class="range-btn" data-range="30d">30 Days</button>
    <button class="range-btn" data-range="90d">90 Days</button>
  </div>
  <div id="panel"><div class="empty">Loading…</div></div>
  <div class="updated-at" id="updated-at"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  return randomBytes(16).toString('base64');
}
