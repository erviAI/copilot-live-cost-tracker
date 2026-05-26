import * as vscode from 'vscode';
import type { DashboardData, BudgetThresholds, BudgetState } from '../domain/models.js';

type AlertLevel = 'ok' | 'warning' | 'limit';

/**
 * BudgetAlertService monitors cost data against configured thresholds
 * and fires VS Code notifications when thresholds are breached.
 *
 * Features:
 * - Two severity levels: warning (yellow) and limit (red)
 * - Debouncing: same threshold only fires once until cost drops back below
 * - Emits budget state for status bar color coding
 */
export class BudgetAlertService implements vscode.Disposable {
  private readonly _onDidChangeBudgetState = new vscode.EventEmitter<BudgetState>();
  readonly onDidChangeBudgetState = this._onDidChangeBudgetState.event;

  private lastState: BudgetState = { sessionLevel: 'ok', dailyLevel: 'ok', weeklyLevel: 'ok' };
  private firedAlerts = new Set<string>();

  constructor(private readonly getThresholds: () => BudgetThresholds) {}

  /** Evaluate dashboard data against budget thresholds */
  evaluate(data: DashboardData): BudgetState {
    const thresholds = this.getThresholds();

    const sessionLevel = this.checkLevel(data.currentSession.totalCost, thresholds.session);
    const dailyLevel = this.checkLevel(data.today.totalCost, thresholds.daily);
    const weeklyLevel = this.checkLevel(data.thisWeek.totalCost, thresholds.weekly);

    const newState: BudgetState = { sessionLevel, dailyLevel, weeklyLevel };

    // Fire notifications for new threshold breaches
    this.maybeNotify('session', sessionLevel, data.currentSession.totalCost, thresholds.session);
    this.maybeNotify('daily', dailyLevel, data.today.totalCost, thresholds.daily);
    this.maybeNotify('weekly', weeklyLevel, data.thisWeek.totalCost, thresholds.weekly);

    // Emit state if changed
    if (
      newState.sessionLevel !== this.lastState.sessionLevel ||
      newState.dailyLevel !== this.lastState.dailyLevel ||
      newState.weeklyLevel !== this.lastState.weeklyLevel
    ) {
      this.lastState = newState;
      this._onDidChangeBudgetState.fire(newState);
    }

    return newState;
  }

  /** Get the current budget state */
  getState(): BudgetState {
    return this.lastState;
  }

  /** Reset alert state (e.g., when session resets) */
  resetAlerts(): void {
    this.firedAlerts.clear();
    this.lastState = { sessionLevel: 'ok', dailyLevel: 'ok', weeklyLevel: 'ok' };
    this._onDidChangeBudgetState.fire(this.lastState);
  }

  private checkLevel(cost: number, threshold: { warning: number; limit: number }): AlertLevel {
    if (cost >= threshold.limit) return 'limit';
    if (cost >= threshold.warning) return 'warning';
    return 'ok';
  }

  private maybeNotify(
    scope: string,
    level: AlertLevel,
    cost: number,
    threshold: { warning: number; limit: number }
  ): void {
    const alertKey = `${scope}:${level}`;

    // Clear alerts if level dropped back to OK
    if (level === 'ok') {
      this.firedAlerts.delete(`${scope}:warning`);
      this.firedAlerts.delete(`${scope}:limit`);
      return;
    }

    // Don't re-fire the same alert
    if (this.firedAlerts.has(alertKey)) return;
    this.firedAlerts.add(alertKey);

    const costStr = `$${cost.toFixed(2)}`;
    const scopeLabel = scope.charAt(0).toUpperCase() + scope.slice(1);

    if (level === 'warning') {
      vscode.window.showWarningMessage(
        `Copilot Cost: ${scopeLabel} spend ${costStr} has reached the warning threshold ($${threshold.warning}).`
      );
    } else if (level === 'limit') {
      vscode.window.showErrorMessage(
        `Copilot Cost: ${scopeLabel} spend ${costStr} has exceeded the limit ($${threshold.limit})!`
      );
    }
  }

  dispose(): void {
    this._onDidChangeBudgetState.dispose();
  }
}
