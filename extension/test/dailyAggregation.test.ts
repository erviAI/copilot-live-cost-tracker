import { describe, it, expect } from 'vitest';
import {
  bucketSessionsByDay,
  sessionsToDailyAggregate,
  mergeDailyAggregates,
  localDateString,
} from '../src/domain/dailyAggregation.js';
import type { SessionInfo, ModelCost, DailyAggregate } from '../src/domain/models.js';

function model(overrides: Partial<ModelCost> = {}): ModelCost {
  return {
    model: 'claude-sonnet-4',
    calls: 1,
    inputTokens: 1000,
    outputTokens: 500,
    cachedTokens: 200,
    cacheWriteTokens: 100,
    freshInputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    outputCost: 0,
    totalCost: 0.1,
    ...overrides,
  };
}

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  const startedAt = overrides.startedAt ?? Date.now();
  return {
    sessionId: 'sess',
    title: 'T',
    model: 'claude-sonnet-4',
    agentName: null,
    workspace: 'proj',
    startedAt,
    endedAt: startedAt + 1000,
    totalCost: 0.1,
    modelTurns: 1,
    inputTokens: 1000,
    outputTokens: 500,
    cachedTokens: 200,
    cacheWriteTokens: 100,
    byModel: [model()],
    ...overrides,
  };
}

describe('bucketSessionsByDay', () => {
  it('buckets sessions by local start day and retains all of them (no 20 cap)', () => {
    const day = new Date(2026, 0, 15, 10, 0, 0).getTime(); // local 2026-01-15
    const sessions = Array.from({ length: 25 }, (_, i) =>
      session({ sessionId: `s${i}`, startedAt: day + i * 1000 })
    );
    const buckets = bucketSessionsByDay(sessions);
    expect(buckets.size).toBe(1);
    expect(buckets.get('2026-01-15')).toHaveLength(25);
  });

  it('separates sessions that start on different days', () => {
    const d1 = new Date(2026, 0, 15, 23, 0, 0).getTime();
    const d2 = new Date(2026, 0, 16, 1, 0, 0).getTime();
    const buckets = bucketSessionsByDay([
      session({ sessionId: 'a', startedAt: d1 }),
      session({ sessionId: 'b', startedAt: d2 }),
    ]);
    expect([...buckets.keys()].sort()).toEqual(['2026-01-15', '2026-01-16']);
  });
});

describe('sessionsToDailyAggregate', () => {
  it('sums per-model and per-workspace and retains the session list', () => {
    const agg = sessionsToDailyAggregate('2026-01-15', [
      session({ sessionId: 'a', workspace: 'proj-a', totalCost: 0.3, modelTurns: 2, byModel: [model({ calls: 2, totalCost: 0.3 })] }),
      session({ sessionId: 'b', workspace: 'proj-b', totalCost: 0.7, modelTurns: 3, byModel: [model({ model: 'gpt-4.1', calls: 3, totalCost: 0.7 })] }),
    ]);
    expect(agg.date).toBe('2026-01-15');
    expect(agg.totalCost).toBeCloseTo(1.0);
    expect(agg.modelTurns).toBe(5);
    expect(agg.sessionCount).toBe(2);
    expect(agg.byModel).toHaveLength(2);
    expect(agg.byWorkspace).toHaveLength(2);
    expect(agg.sessions).toHaveLength(2);
  });
});

describe('mergeDailyAggregates', () => {
  const day = '2026-01-15';

  it('returns incoming when there is no existing aggregate', () => {
    const incoming = sessionsToDailyAggregate(day, [session({ sessionId: 'a' })]);
    expect(mergeDailyAggregates(null, incoming)).toBe(incoming);
  });

  it('keeps the higher per-session cost (monotonic) on overlap', () => {
    const existing = sessionsToDailyAggregate(day, [session({ sessionId: 'a', totalCost: 1.0, byModel: [model({ totalCost: 1.0 })] })]);
    const incoming = sessionsToDailyAggregate(day, [session({ sessionId: 'a', totalCost: 0.25, byModel: [model({ totalCost: 0.25 })] })]);
    const merged = mergeDailyAggregates(existing, incoming);
    expect(merged.totalCost).toBeCloseTo(1.0);
    expect(merged.sessionCount).toBe(1);
  });

  it('unions sessions, keeping ones absent from the later read', () => {
    const existing = sessionsToDailyAggregate(day, [
      session({ sessionId: 'a', totalCost: 0.4, byModel: [model({ totalCost: 0.4 })] }),
      session({ sessionId: 'b', totalCost: 0.6, byModel: [model({ totalCost: 0.6 })] }),
    ]);
    const incoming = sessionsToDailyAggregate(day, [session({ sessionId: 'b', totalCost: 0.6, byModel: [model({ totalCost: 0.6 })] })]);
    const merged = mergeDailyAggregates(existing, incoming);
    expect(merged.sessionCount).toBe(2);
    expect(merged.totalCost).toBeCloseTo(1.0);
  });

  it('raises totals when a session grows', () => {
    const existing = sessionsToDailyAggregate(day, [session({ sessionId: 'a', totalCost: 0.2, byModel: [model({ totalCost: 0.2 })] })]);
    const incoming = sessionsToDailyAggregate(day, [session({ sessionId: 'a', totalCost: 0.9, byModel: [model({ totalCost: 0.9 })] })]);
    expect(mergeDailyAggregates(existing, incoming).totalCost).toBeCloseTo(0.9);
  });

  it('falls back to higher-cost aggregate when a side lacks per-session detail', () => {
    // Simulates a daily file written by an older version (no sessions[]).
    const legacy: DailyAggregate = {
      date: day,
      totalCost: 2.0,
      modelTurns: 10,
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 20,
      cacheWriteTokens: 10,
      byModel: [],
      byWorkspace: [],
      sessionCount: 3,
    };
    const incoming = sessionsToDailyAggregate(day, [session({ sessionId: 'a', totalCost: 0.5, byModel: [model({ totalCost: 0.5 })] })]);
    const merged = mergeDailyAggregates(legacy, incoming);
    expect(merged.totalCost).toBeCloseTo(2.0); // legacy total wins (higher)
  });
});

describe('localDateString', () => {
  it('formats a timestamp as local YYYY-MM-DD', () => {
    const ms = new Date(2026, 5, 24, 9, 30, 0).getTime();
    expect(localDateString(ms)).toBe('2026-06-24');
  });
});
