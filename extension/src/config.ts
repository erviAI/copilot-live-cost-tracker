import * as vscode from 'vscode';
import type { BudgetThresholds, ModelPricing } from './domain/models.js';

const SECTION = 'copilotCostTracker';

/**
 * Configuration accessor — reads from VS Code settings.
 * Single place for all configuration reads.
 */
export function getPollingInterval(): number {
  return vscode.workspace.getConfiguration(SECTION).get<number>('pollingInterval', 10);
}

export function getBudgetThresholds(): BudgetThresholds {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    session: {
      warning: config.get<number>('budget.session.warning', 5),
      limit: config.get<number>('budget.session.limit', 8),
    },
    daily: {
      warning: config.get<number>('budget.daily.warning', 20),
      limit: config.get<number>('budget.daily.limit', 50),
    },
    weekly: {
      warning: config.get<number>('budget.weekly.warning', 25),
      limit: config.get<number>('budget.weekly.limit', 50),
    },
  };
}

export function getPricingOverrides(): Record<string, ModelPricing> | undefined {
  const config = vscode.workspace.getConfiguration(SECTION);
  const overrides = config.get<Record<string, ModelPricing>>('pricingOverrides');
  if (!overrides || Object.keys(overrides).length === 0) return undefined;
  return overrides;
}

export type CostDataSource = 'agent-traces-only' | 'with-fallback';

export function getCostDataSource(): CostDataSource {
  return vscode.workspace.getConfiguration(SECTION).get<CostDataSource>('costDataSource', 'agent-traces-only');
}

export function getHistoryEnabled(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('history.enabled', true);
}

export function getHistoryRetentionDays(): number {
  return vscode.workspace.getConfiguration(SECTION).get<number>('history.retentionDays', 90);
}

export function getHistoryScrapeInterval(): number {
  return vscode.workspace.getConfiguration(SECTION).get<number>('history.scrapeInterval', 30);
}

export interface DisplayCurrency {
  code: string;
  rate: number;
}

export function getDisplayCurrency(): DisplayCurrency | undefined {
  const config = vscode.workspace.getConfiguration(SECTION);
  const code = config.get<string>('displayCurrency.code', '').trim().toUpperCase();
  if (!code) return undefined;
  const rate = config.get<number>('displayCurrency.rate', 1);
  if (rate <= 0) return undefined;
  return { code, rate };
}
