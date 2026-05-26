import * as vscode from 'vscode';
import type { DashboardData, BudgetState } from '../domain/models.js';

/**
 * StatusBarController manages the status bar item that shows
 * current session and daily costs with color-coded budget indicators.
 */
export class StatusBarController implements vscode.Disposable {
  private readonly statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      50
    );
    this.statusBarItem.command = 'copilotCostTracker.openDashboard';
    this.statusBarItem.tooltip = 'Click to open Copilot Cost Dashboard';
    this.statusBarItem.text = '$(pulse) Copilot Cost: --';
    this.statusBarItem.show();
  }

  /** Update the status bar with latest cost data */
  update(data: DashboardData, budgetState: BudgetState): void {
    const sessionCost = formatCost(data.currentSession.totalCost);
    const todayCost = formatCost(data.today.totalCost);

    this.statusBarItem.text = `$(pulse) Session: ${sessionCost} | Today: ${todayCost}`;
    this.statusBarItem.backgroundColor = this.getBackgroundColor(budgetState);
    this.statusBarItem.tooltip = this.buildTooltip(data, budgetState);
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
    const lines = [
      `Copilot Cost Tracker`,
      `──────────────────`,
      `Session: ${formatCost(data.currentSession.totalCost)} (${data.currentSession.requests} requests)`,
      `Today:   ${formatCost(data.today.totalCost)} (${data.today.requests} requests)`,
      `Week:    ${formatCost(data.thisWeek.totalCost)} (${data.thisWeek.requests} requests)`,
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
