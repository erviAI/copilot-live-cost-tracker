import * as vscode from 'vscode';
import type { BudgetThresholds, ModelPricing } from './domain/models.js';

const SECTION = 'copilotCostTracker';

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
