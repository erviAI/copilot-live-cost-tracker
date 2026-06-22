import { describe, it, expect } from 'vitest';
import { buildRangeSummary, periodCostToDailyAggregate, RANGE_PRESETS } from '../src/domain/rangeSummary.js';
import type { DailyAggregate, PeriodCost } from '../src/domain/models.js';

function makeDaily(date: string, overrides: Partial<DailyAggregate> = {}): DailyAggregate {
  return {
    date,
    totalCost: 1,
    modelTurns: 2,
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 25,
    cacheWriteTokens: 10,
    byModel: [
      { model: 'gpt-4.1', calls: 2, inputTokens: 100, outputTokens: 50, cachedTokens: 25, cacheWriteTokens: 10, totalCost: 1 },
    ],
    byWorkspace: [],
    sessionCount: 1,
    ...overrides,
  };
}

describe('rangeSummary', () => {
  // Fixed "now" = 2026-06-22 (local). End date should be 2026-06-22.
  const now = new Date(2026, 5, 22, 12, 0, 0);

  describe('buildRangeSummary', () => {
    it('sums only days within the preset window', () => {
      const history = [
        makeDaily('2026-06-20'),
        makeDaily('2026-06-21'),
        // Outside a 2-day-equivalent window but inside 7d:
        makeDaily('2026-06-16'),
        // Way outside 7d window — must be excluded:
        makeDaily('2026-06-01', { totalCost: 999 }),
      ];

      const result = buildRangeSummary('7d', history, null, now);

      expect(result.preset).toBe('7d');
      expect(result.days).toBe(7);
      expect(result.startDate).toBe('2026-06-16');
      expect(result.endDate).toBe('2026-06-22');
      // 3 in-window days (06-16, 06-20, 06-21); 06-01 excluded
      expect(result.daysWithData).toBe(3);
      expect(result.totalCost).toBe(3);
      expect(result.modelTurns).toBe(6);
    });

    it('lets today override a stale same-day history entry', () => {
      const history = [makeDaily('2026-06-22', { totalCost: 5, modelTurns: 10 })];
      const today = makeDaily('2026-06-22', { totalCost: 8, modelTurns: 16 });

      const result = buildRangeSummary('7d', history, today, now);

      // Today wins — not summed with the stale history entry.
      expect(result.totalCost).toBe(8);
      expect(result.modelTurns).toBe(16);
      expect(result.daysWithData).toBe(1);
    });

    it('merges per-model token totals across days', () => {
      const history = [
        makeDaily('2026-06-21'),
        makeDaily('2026-06-22', {
          byModel: [
            { model: 'gpt-4.1', calls: 1, inputTokens: 50, outputTokens: 20, cachedTokens: 5, cacheWriteTokens: 2, totalCost: 0.5 },
            { model: 'claude-opus-4-5', calls: 3, inputTokens: 300, outputTokens: 100, cachedTokens: 0, cacheWriteTokens: 0, totalCost: 4 },
          ],
        }),
      ];

      const result = buildRangeSummary('30d', history, null, now);

      const gpt = result.byModel.find(m => m.model === 'gpt-4.1')!;
      expect(gpt.calls).toBe(3); // 2 (day1) + 1 (day2)
      expect(gpt.inputTokens).toBe(150); // 100 + 50
      // Sorted by cost descending — claude (4) before gpt (1.5)
      expect(result.byModel[0].model).toBe('claude-opus-4-5');
    });

    it('returns an empty summary when there is no data', () => {
      const result = buildRangeSummary('90d', [], null, now);
      expect(result.totalCost).toBe(0);
      expect(result.daysWithData).toBe(0);
      expect(result.byModel).toHaveLength(0);
      expect(result.days).toBe(RANGE_PRESETS['90d']);
    });
  });

  describe('periodCostToDailyAggregate', () => {
    it('maps a PeriodCost and derives cacheWriteTokens from per-model data', () => {
      const period: PeriodCost = {
        totalCost: 2.5,
        modelTurns: 4,
        inputTokens: 200,
        outputTokens: 80,
        cachedTokens: 40,
        byModel: [
          { model: 'gpt-4.1', calls: 4, inputTokens: 200, outputTokens: 80, cachedTokens: 40, cacheWriteTokens: 12, freshInputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, outputCost: 0, totalCost: 2.5 },
        ],
        byWorkspace: [],
      };

      const agg = periodCostToDailyAggregate(period, '2026-06-22');

      expect(agg.date).toBe('2026-06-22');
      expect(agg.totalCost).toBe(2.5);
      expect(agg.cacheWriteTokens).toBe(12);
      expect(agg.byModel[0].model).toBe('gpt-4.1');
    });
  });
});
