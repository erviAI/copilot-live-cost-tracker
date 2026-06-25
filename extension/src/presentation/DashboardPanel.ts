import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import type { DashboardData, BudgetState, RangePreset, RangeSummary, RecentPrompt } from '../domain/models.js';
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
  private recentTurnsHandler: (() => Promise<RecentPrompt[]>) | null = null;
  private pendingSessionModal: { sessionId: string; traceId?: string } | null = null;

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
      'Copilot Live Cost & Token Tracker',
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

  /** Set the handler invoked when the webview requests recent per-prompt costs. */
  setRecentTurnsHandler(handler: () => Promise<RecentPrompt[]>): void {
    this.recentTurnsHandler = handler;
  }

  /** Push new dashboard data to the panel. */
  update(data: DashboardData, budgetState: BudgetState | null): void {
    this.latestData = data;
    this.latestBudgetState = budgetState;
    this.post();
  }

  /** Reveal the panel and open the detail modal for a session (optionally
   * auto-expanding a specific prompt by trace id). */
  revealSessionModal(sessionId: string, traceId?: string): void {
    this.pendingSessionModal = { sessionId, traceId };
    this.panel.reveal(this.panel.viewColumn);
    // Post immediately for an already-loaded webview; the 'ready' handler
    // re-sends it for a freshly created panel whose listener isn't attached yet.
    this.flushSessionModal();
  }

  private flushSessionModal(): void {
    if (!this.pendingSessionModal) return;
    const { sessionId, traceId } = this.pendingSessionModal;
    this.panel.webview.postMessage({ type: 'openSessionModal', sessionId, traceId });
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
        this.flushSessionModal();
        this.pendingSessionModal = null;
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
      case 'recentTurns': {
        if (this.recentTurnsHandler) {
          const turns = await this.recentTurnsHandler();
          this.panel.webview.postMessage({ type: 'recentTurns', turns });
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
  <title>Copilot Live Cost & Token Tracker</title>
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
    .prompts-wrap { margin-top: 16px; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 12px; }
    .prompts-title { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); margin-bottom: 8px; font-weight: 600; }
    .prompts-msg { color: var(--text-secondary); font-size: 0.85em; padding: 8px 0; }
    .prompts-table { width: 100%; border-collapse: collapse; font-size: 0.82em; }
    .prompts-table th { text-align: left; color: var(--text-secondary); font-weight: 600; padding: 4px 8px; border-bottom: 1px solid var(--card-border); }
    .prompts-table td { padding: 4px 8px; border-bottom: 1px solid var(--card-border); vertical-align: top; }
    .prompts-table tr:last-child td { border-bottom: none; }
    .prompts-table .num { text-align: right; white-space: nowrap; }
    .prompts-session { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-secondary); }
    .prompts-label { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .prompts-muted { color: var(--text-secondary); font-style: italic; }

    /* Session-grouped Activity rows */
    .session-row { cursor: pointer; }
    .session-row > td { font-weight: 600; background: rgba(127,127,127,0.05); }
    .session-row:hover > td { background: var(--card-border); }
    .session-cell { max-width: 220px; color: var(--accent, #3584e4); }
    .session-cell:hover { text-decoration: underline; }
    .session-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-expand-cell { display: flex; align-items: center; gap: 6px; }
    .session-expand-cell .section-chevron { flex-shrink: 0; }
    .prompt-subrow .prompt-indent { padding-left: 22px; }

    /* Session modal: per-prompt entries */
    .session-prompts { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
    .session-prompt { border: 1px solid var(--card-border); border-radius: 6px; overflow: hidden; }
    .session-prompt-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; user-select: none; }
    .session-prompt-head:hover { background: var(--card-border); }
    .session-prompt-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.88em; }
    .session-prompt-totals { flex-shrink: 0; font-size: 0.78em; color: var(--text-secondary); white-space: nowrap; }
    .session-prompt-body { padding: 8px 10px; border-top: 1px solid var(--card-border); }
    .session-prompt-body.hidden { display: none; }

    /* Collapsible sections */
    .section { margin-bottom: 16px; }
    .section-head { display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; padding: 6px 0; font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); font-weight: 600; }
    .section-head:hover { color: var(--text-primary, inherit); }
    .section-chevron { font-size: 1em; width: 12px; display: inline-block; }
    .section-title { flex-shrink: 0; }
    .section-body { margin-top: 8px; }
    .section-body.hidden { display: none; }

    /* KPI info badges + popover */
    .info-badge { display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-left: 5px; border-radius: 50%; background: var(--card-border); color: var(--text-secondary); font-size: 9px; font-weight: 700; font-style: normal; cursor: pointer; vertical-align: middle; line-height: 1; }
    .info-badge:hover { background: var(--accent, #3584e4); color: #fff; }
    .info-pop { position: absolute; z-index: 1000; max-width: 280px; background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 10px 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.35); font-size: 0.8em; }
    .info-pop-title { font-weight: 700; margin-bottom: 4px; }
    .info-pop-text { color: var(--text-secondary); line-height: 1.4; }

    /* Prompt rows + inline detail */
    .prompt-row { cursor: pointer; }
    .prompt-row:hover td { background: var(--card-border); }
    .prompt-caret { display: inline-block; width: 10px; color: var(--text-secondary); }
    .prompt-detail-row.hidden { display: none; }
    .prompt-detail-row > td { background: rgba(127,127,127,0.06); padding: 10px 14px !important; }
    .detail-wrap { display: flex; flex-direction: column; gap: 8px; }
    .detail-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .detail-summary { font-size: 0.85em; color: var(--text-secondary); }
    .detail-modal-btn { background: transparent; color: var(--accent, #3584e4); border: 1px solid var(--card-border); border-radius: 4px; padding: 3px 8px; font-size: 0.8em; cursor: pointer; white-space: nowrap; }
    .detail-modal-btn:hover { background: var(--card-border); }
    .detail-section-title { font-size: 0.72em; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); font-weight: 600; margin: 6px 0 2px; }
    .detail-table { width: 100%; border-collapse: collapse; font-size: 0.78em; }
    .detail-table th { text-align: left; color: var(--text-secondary); font-weight: 600; padding: 3px 6px; border-bottom: 1px solid var(--card-border); }
    .detail-table td { padding: 3px 6px; border-bottom: 1px solid var(--card-border); }
    .detail-table .num { text-align: right; white-space: nowrap; }
    .detail-table .detail-op { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .detail-table .detail-tools { white-space: nowrap; max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
    .detail-table .detail-tools .section-chevron { font-size: 0.85em; opacity: 0.8; }
    .detail-table .tool-ok { color: var(--cost-green, #4e9a06); }
    .detail-table .tool-err { color: var(--cost-red, #c01c28); font-weight: 600; }
    .detail-table tr.span-row.clickable { cursor: pointer; }
    .detail-table tr.span-row.clickable:hover > td { background: rgba(127,127,127,0.08); }
    .span-tools-row > td { padding: 0 !important; border-bottom: 1px solid var(--card-border); }
    .span-tools-wrap { padding: 4px 6px 6px 22px; }
    .detail-table tr.tool-row.clickable { cursor: pointer; }
    .detail-table tr.tool-row.clickable:hover > td { background: rgba(127,127,127,0.08); }
    .tool-detail-row > td { padding: 0 !important; border-bottom: 1px solid var(--card-border); }
    .tool-detail-wrap { padding: 6px 6px 8px 22px; }
    .tool-detail-block { margin-bottom: 6px; }
    .tool-detail-label { font-size: 0.7em; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-secondary); font-weight: 600; margin-bottom: 2px; }
    .tool-detail-pre { margin: 0; padding: 6px 8px; background: rgba(127,127,127,0.08); border: 1px solid var(--card-border); border-radius: 4px; font-size: 0.76em; line-height: 1.4; white-space: pre-wrap; word-break: break-word; max-height: 260px; overflow: auto; }
    .tool-detail-pre.tool-detail-err { color: var(--cost-red, #c01c28); }
    .text-panel { margin: 4px 0 8px; }
    .text-panel-head { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; font-size: 0.8em; font-weight: 600; }
    .text-panel-head .section-chevron { font-size: 0.85em; opacity: 0.8; }
    .text-panel-title { flex: 0 0 auto; }
    .text-panel-preview { font-weight: 400; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .text-panel-pre { margin: 4px 0 0; padding: 8px 10px; background: rgba(127,127,127,0.08); border: 1px solid var(--card-border); border-radius: 4px; font-size: 0.8em; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow: auto; }
    .detail-subtitle { font-size: 0.72em; color: var(--text-secondary); font-weight: 600; margin: 6px 0 2px; }
    .detail-child { margin-top: 8px; padding-left: 10px; border-left: 2px solid var(--card-border); }
    .detail-child-head { font-size: 0.8em; font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
    .detail-child-head .section-chevron { font-size: 0.85em; opacity: 0.8; }
    .detail-child-name { flex: 0 0 auto; }
    .detail-child-totals { font-weight: 400; opacity: 0.75; }
    .detail-child-body.hidden { display: none; }

    /* Modal */
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center; z-index: 2000; padding: 24px; }
    .modal-overlay.hidden { display: none; }
    .modal { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px; width: 100%; height: 100%; display: flex; flex-direction: column; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
    .modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--card-border); }
    .modal-head span { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .modal-head button { background: transparent; border: none; color: var(--text-secondary); font-size: 1.1em; cursor: pointer; }
    .modal-head button:hover { color: var(--text-primary, inherit); }
    .modal-body { padding: 14px 16px; overflow-y: auto; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Copilot Live Cost & Token Tracker</h1>
    <button class="toolbar-btn" id="btn-refresh">Refresh</button>
    <button class="toolbar-btn" id="btn-settings">Settings</button>
  </div>
  <div class="tabs">
    <button class="tab active" data-tab="activity">Activity</button>
    <button class="tab" data-tab="cost">Cost</button>
    <button class="tab" data-tab="models">Models</button>
  </div>
  <div class="range-selector">
    <button class="range-btn active" data-range="7d">7 Days</button>
    <button class="range-btn" data-range="30d">30 Days</button>
    <button class="range-btn" data-range="90d">90 Days</button>
  </div>
  <div id="panel"><div class="empty">Loading…</div></div>
  <div class="updated-at" id="updated-at"></div>
  <div id="modal-overlay" class="modal-overlay hidden">
    <div class="modal">
      <div class="modal-head"><span id="modal-title"></span><button id="modal-close" aria-label="Close">✕</button></div>
      <div class="modal-body" id="modal-body"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  return randomBytes(16).toString('base64');
}
