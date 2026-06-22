import { describe, it, expect, beforeEach } from 'vitest';
import { BudgetAlertService } from '../src/services/BudgetAlertService.js';
import type { INotifier } from '../src/services/INotifier.js';
import type { DashboardData, BudgetThresholds, PeriodCost } from '../src/domain/models.js';

class FakeNotifier implements INotifier {
  warnings: string[] = [];
  errors: string[] = [];
  warn(message: string): void {
    this.warnings.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
}

const thresholds: BudgetThresholds = {
  session: { warning: 1, limit: 2 },
  daily: { warning: 5, limit: 10 },
  weekly: { warning: 20, limit: 40 },
};

function emptyPeriod(totalCost: number): PeriodCost {
  return {
    totalCost,
    modelTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    byModel: [],
    byWorkspace: [],
  };
}

function dashboard(sessionCost: number, dailyCost = 0, weeklyCost = 0): DashboardData {
  return {
    today: emptyPeriod(dailyCost),
    thisWeek: emptyPeriod(weeklyCost),
    currentSession: {
      ...emptyPeriod(sessionCost),
      sessionId: 's1',
      title: null,
      agentName: null,
      workspace: null,
      latestSpanTimeMs: null,
      spanCount: 0,
      contextWeightTokens: 0,
    },
    last7Days: [],
    recentSessions: [],
    updatedAt: new Date().toISOString(),
  };
}

describe('BudgetAlertService', () => {
  let notifier: FakeNotifier;
  let service: BudgetAlertService;

  beforeEach(() => {
    notifier = new FakeNotifier();
    service = new BudgetAlertService(() => thresholds, notifier);
  });

  it('does not notify when all costs are below thresholds', () => {
    const state = service.evaluate(dashboard(0.5));
    expect(state).toEqual({ sessionLevel: 'ok', dailyLevel: 'ok', weeklyLevel: 'ok' });
    expect(notifier.warnings).toHaveLength(0);
    expect(notifier.errors).toHaveLength(0);
  });

  it('fires a warning when the session warning threshold is reached', () => {
    const state = service.evaluate(dashboard(1.5));
    expect(state.sessionLevel).toBe('warning');
    expect(notifier.warnings).toHaveLength(1);
    expect(notifier.errors).toHaveLength(0);
  });

  it('fires an error when the session limit is exceeded', () => {
    const state = service.evaluate(dashboard(2.5));
    expect(state.sessionLevel).toBe('limit');
    expect(notifier.errors).toHaveLength(1);
  });

  it('debounces repeated alerts at the same level', () => {
    service.evaluate(dashboard(1.5));
    service.evaluate(dashboard(1.6));
    service.evaluate(dashboard(1.7));
    expect(notifier.warnings).toHaveLength(1);
  });

  it('re-arms an alert after the cost drops back to ok', () => {
    service.evaluate(dashboard(1.5)); // warning fires
    service.evaluate(dashboard(0.2)); // back to ok, clears
    service.evaluate(dashboard(1.5)); // warning fires again
    expect(notifier.warnings).toHaveLength(2);
  });

  it('resetAlerts clears fired state and emits ok', () => {
    service.evaluate(dashboard(2.5));
    let emitted = false;
    service.onDidChangeBudgetState(() => {
      emitted = true;
    });
    service.resetAlerts();
    expect(emitted).toBe(true);
    expect(service.getState()).toEqual({ sessionLevel: 'ok', dailyLevel: 'ok', weeklyLevel: 'ok' });
  });

  it('emits budget state when a level changes', () => {
    const states: string[] = [];
    service.onDidChangeBudgetState((s) => states.push(s.sessionLevel));
    service.evaluate(dashboard(1.5));
    service.evaluate(dashboard(2.5));
    expect(states).toEqual(['warning', 'limit']);
  });
});
