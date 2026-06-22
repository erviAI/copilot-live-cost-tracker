import type {
  DailyAggregate,
  ModelCostSnapshot,
  PeriodCost,
  RangeDailyPoint,
  RangePreset,
  RangeSummary,
} from './models.js';

/** Number of days each preset window spans (inclusive of today). */
export const RANGE_PRESETS: Record<RangePreset, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/** Local-time YYYY-MM-DD string for a date. */
function localDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Convert today's live PeriodCost into a DailyAggregate so it can be merged with
 * persisted history. The top-level cacheWriteTokens is summed from per-model data
 * (PeriodCost only tracks it per model).
 */
export function periodCostToDailyAggregate(period: PeriodCost, date: string): DailyAggregate {
  const byModel: ModelCostSnapshot[] = period.byModel.map(m => ({
    model: m.model,
    calls: m.calls,
    inputTokens: m.inputTokens,
    outputTokens: m.outputTokens,
    cachedTokens: m.cachedTokens,
    cacheWriteTokens: m.cacheWriteTokens,
    totalCost: m.totalCost,
  }));
  const cacheWriteTokens = byModel.reduce((sum, m) => sum + m.cacheWriteTokens, 0);
  return {
    date,
    totalCost: period.totalCost,
    modelTurns: period.modelTurns,
    inputTokens: period.inputTokens,
    outputTokens: period.outputTokens,
    cachedTokens: period.cachedTokens,
    cacheWriteTokens,
    byModel,
    byWorkspace: period.byWorkspace,
    sessionCount: 0,
  };
}

/**
 * Build a cost summary for the selected preset window by combining persisted
 * daily history with today's live snapshot.
 *
 * Past days come from `history`; today comes from `today` (which overrides any
 * stale same-day history entry). Only days inside the [start, end] window are
 * counted, so callers may pass a slightly wider history set safely.
 */
export function buildRangeSummary(
  preset: RangePreset,
  history: DailyAggregate[],
  today: DailyAggregate | null,
  now: Date
): RangeSummary {
  const days = RANGE_PRESETS[preset];
  const endDate = localDateStr(now);
  const start = new Date(now);
  start.setDate(start.getDate() - (days - 1));
  const startDate = localDateStr(start);

  // Merge by date; today wins over any stale history entry for the same day.
  const byDate = new Map<string, DailyAggregate>();
  for (const d of history) byDate.set(d.date, d);
  if (today) byDate.set(today.date, today);

  const inRange: DailyAggregate[] = [];
  for (const d of byDate.values()) {
    if (d.date >= startDate && d.date <= endDate) inRange.push(d);
  }
  inRange.sort((a, b) => a.date.localeCompare(b.date));

  const modelMap = new Map<string, ModelCostSnapshot>();
  let totalCost = 0;
  let modelTurns = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let cacheWriteTokens = 0;

  for (const d of inRange) {
    totalCost += d.totalCost;
    modelTurns += d.modelTurns;
    inputTokens += d.inputTokens;
    outputTokens += d.outputTokens;
    cachedTokens += d.cachedTokens;
    cacheWriteTokens += d.cacheWriteTokens;
    for (const m of d.byModel) {
      const existing = modelMap.get(m.model);
      if (existing) {
        existing.calls += m.calls;
        existing.inputTokens += m.inputTokens;
        existing.outputTokens += m.outputTokens;
        existing.cachedTokens += m.cachedTokens;
        existing.cacheWriteTokens += m.cacheWriteTokens;
        existing.totalCost += m.totalCost;
      } else {
        modelMap.set(m.model, { ...m });
      }
    }
  }

  const daily: RangeDailyPoint[] = inRange.map(d => ({
    date: d.date,
    totalCost: d.totalCost,
    modelTurns: d.modelTurns,
  }));

  return {
    preset,
    days,
    startDate,
    endDate,
    totalCost,
    modelTurns,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheWriteTokens,
    byModel: [...modelMap.values()].sort((a, b) => b.totalCost - a.totalCost),
    daily,
    daysWithData: inRange.length,
  };
}
