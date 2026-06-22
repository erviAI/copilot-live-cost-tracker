import * as vscode from 'vscode';
import type { BudgetThresholds, ModelPricing } from './domain/models.js';

const SECTION = 'copilotLiveCostTracker';
const MAX_BUDGET_THRESHOLD = 1_000_000;

/**
 * VS Code setting that makes Copilot Chat persist OpenTelemetry spans to the
 * local `agent-traces.db` this extension reads from. Without it enabled, no
 * data source exists. See:
 * https://code.visualstudio.com/docs/agents/guides/monitoring-agents#_content-capture
 */
export const OTEL_DB_SPAN_EXPORTER_SETTING = 'github.copilot.chat.otel.dbSpanExporter.enabled';

/** Whether Copilot Chat's OTel DB span exporter is enabled (data source prerequisite). */
export function isOtelDbSpanExporterEnabled(): boolean {
  return vscode.workspace.getConfiguration().get<boolean>(OTEL_DB_SPAN_EXPORTER_SETTING, false);
}

/** Clamp a number to a sane range, falling back to a default for non-finite input. */
function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/**
 * Configuration accessor — reads from VS Code settings.
 * Single place for all configuration reads.
 */
export function getPollingInterval(): number {
  const raw = vscode.workspace.getConfiguration(SECTION).get<number>('pollingInterval', 10);
  // Never below 1s (avoids a 0ms busy-loop) or above 1h.
  return clamp(raw, 1, 3600, 10);
}

export function getBudgetThresholds(): BudgetThresholds {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    session: getBudgetThreshold(config, 'budget.session.warning', 'budget.session.limit', { warning: 5, limit: 8 }),
    daily: getBudgetThreshold(config, 'budget.daily.warning', 'budget.daily.limit', { warning: 20, limit: 50 }),
    weekly: getBudgetThreshold(config, 'budget.weekly.warning', 'budget.weekly.limit', { warning: 25, limit: 50 }),
  };
}

function getBudgetThreshold(
  config: vscode.WorkspaceConfiguration,
  warningKey: string,
  limitKey: string,
  defaults: { warning: number; limit: number }
): { warning: number; limit: number } {
  const warning = toBudgetValue(config.get<unknown>(warningKey), defaults.warning);
  const limit = toBudgetValue(config.get<unknown>(limitKey), defaults.limit);
  return warning <= limit ? { warning, limit } : defaults;
}

function toBudgetValue(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.min(value, MAX_BUDGET_THRESHOLD);
}

export function getPricingOverrides(): Record<string, ModelPricing> | undefined {
  const config = vscode.workspace.getConfiguration(SECTION);
  const overrides = config.get<Record<string, unknown>>('pricingOverrides');
  if (!overrides || typeof overrides !== 'object' || Object.keys(overrides).length === 0) return undefined;

  // User settings are a trust boundary — validate each entry's shape and drop
  // malformed ones so invalid numbers can never reach the cost math.
  const validated: Record<string, ModelPricing> = {};
  for (const [key, value] of Object.entries(overrides)) {
    const pricing = toModelPricing(value);
    if (pricing) validated[key] = pricing;
  }
  return Object.keys(validated).length > 0 ? validated : undefined;
}

/** Validate an untrusted settings value into a ModelPricing, or null if malformed. */
function toModelPricing(value: unknown): ModelPricing | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const isRate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  if (!isRate(v.input) || !isRate(v.output) || !isRate(v.cached)) return null;
  const pricing: ModelPricing = { input: v.input, output: v.output, cached: v.cached };
  if (v.cacheWrite !== undefined) {
    if (!isRate(v.cacheWrite)) return null;
    pricing.cacheWrite = v.cacheWrite;
  }
  return pricing;
}

export type CostDataSource = 'agent-traces-only' | 'with-fallback';

export function getCostDataSource(): CostDataSource {
  return vscode.workspace.getConfiguration(SECTION).get<CostDataSource>('costDataSource', 'agent-traces-only');
}

export function getHistoryEnabled(): boolean {
  return vscode.workspace.getConfiguration(SECTION).get<boolean>('history.enabled', true);
}

export function getHistoryRetentionDays(): number {
  const raw = vscode.workspace.getConfiguration(SECTION).get<number>('history.retentionDays', 90);
  return clamp(raw, 1, 3650, 90);
}

export function getHistoryScrapeInterval(): number {
  const raw = vscode.workspace.getConfiguration(SECTION).get<number>('history.scrapeInterval', 30);
  // Used as a modulo divisor on the poll counter; must be >= 1 to avoid `% 0` (NaN).
  return clamp(Math.round(raw), 1, 100000, 30);
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
