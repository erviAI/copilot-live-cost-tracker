import * as vscode from 'vscode';
import type { DashboardData, BudgetState, DataSourceStatus } from '../domain/models.js';
import { getDisplayCurrency } from '../config.js';

/**
 * StatusBarController manages the status bar item that shows
 * current session and daily costs with color-coded budget indicators.
 */
export class StatusBarController implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      50
    );
    this.statusBarItem.command = 'copilotCostTracker.openDashboard';
    this.statusBarItem.tooltip = 'Click to open Copilot Cost Dashboard';
    this.statusBarItem.text = '$(pulse) Copilot Cost: --';
    this.statusBarItem.show();
  }

  /** Update the status bar with latest cost data */
  update(data: DashboardData, budgetState: BudgetState): void {
    // Check for data source unavailability first
    if (data.dataSourceStatus?.source === 'none') {
      this.statusBarItem.text = '$(warning) Copilot Cost: No Data';
      this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      this.statusBarItem.tooltip = this.buildUnavailableTooltip(data.dataSourceStatus);
      return;
    }

    const sessionCost = formatCost(data.currentSession.totalCost);
    const todayCost = formatCost(data.today.totalCost);

    this.statusBarItem.text = `$(pulse) Session: ${sessionCost} | Today: ${todayCost}`;
    this.statusBarItem.backgroundColor = this.getBackgroundColor(budgetState);
    this.statusBarItem.tooltip = this.buildTooltip(data, budgetState);
  }

  private buildUnavailableTooltip(status: DataSourceStatus): string {
    const lines = [
      'Copilot Cost Tracker',
      '──────────────────',
      '⚠️ Data source unavailable',
      '',
      status.message ?? 'agent-traces.db not found',
      '',
      'Click to open dashboard for more info',
    ];
    return lines.join('\n');
  }

  private getBackgroundColor(state: BudgetState): vscode.ThemeColor | undefined {
    // Highest severity wins
    if (
      state.sessionLevel === 'limit' ||
      state.dailyLevel === 'limit' ||
      state.weeklyLevel === 'limit'
    ) {
      return new vscode.ThemeColor('statusBarItem.errorBackground');
    }
    if (
      state.sessionLevel === 'warning' ||
      state.dailyLevel === 'warning' ||
      state.weeklyLevel === 'warning'
    ) {
      return new vscode.ThemeColor('statusBarItem.warningBackground');
    }
    return undefined;
  }

  private buildTooltip(data: DashboardData, state: BudgetState): string {
    const currency = getDisplayCurrency();
    const converted = (cost: number) =>
      currency ? ` (~${(cost * currency.rate).toFixed(2)} ${currency.code})` : '';

    const lines = [
      `Copilot Cost Tracker`,
      `──────────────────`,
      `Session: ${formatCost(data.currentSession.totalCost)}${converted(data.currentSession.totalCost)} (${data.currentSession.modelTurns} model turns)`,
      `Today:   ${formatCost(data.today.totalCost)}${converted(data.today.totalCost)} (${data.today.modelTurns} model turns)`,
      `Week:    ${formatCost(data.thisWeek.totalCost)}${converted(data.thisWeek.totalCost)} (${data.thisWeek.modelTurns} model turns)`,
      ``,
      `Tokens today: ${formatTokens(data.today.inputTokens)} in / ${formatTokens(data.today.outputTokens)} out / ${formatTokens(data.today.cachedTokens)} cached`,
      ``,
      `Updated: ${new Date(data.updatedAt).toLocaleTimeString()}`,
    ];

    if (state.sessionLevel !== 'ok' || state.dailyLevel !== 'ok' || state.weeklyLevel !== 'ok') {
      lines.push(``, `⚠️ Budget alert active`);
    }

    return lines.join('\n');
  }

  dispose(): void {
    this.statusBarItem.dispose();
  }
}

function formatCost(cost: number): string {
  if (cost < 0.01 && cost > 0) return '< $0.01';
  return `$${cost.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return `${count}`;
}
