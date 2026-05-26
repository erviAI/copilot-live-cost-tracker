import type { Span, ModelCost, PeriodCost, DailyBucket, SessionInfo, DashboardData } from './models.js';
import { CostCalculator } from './CostCalculator.js';

/**
 * Aggregator groups spans into time-bucketed and model-bucketed cost summaries.
 * Produces the DashboardData DTO consumed by the presentation layer.
 */
export class Aggregator {
  constructor(private readonly calculator: CostCalculator) {}

  /**
   * Build complete dashboard data from raw spans and session info.
   */
  buildDashboard(
    allSpans: Span[],
    sessionTitles: Map<string, string>,
    currentSessionId: string | null
  ): DashboardData {
    const now = new Date();
    const todayStart = startOfDay(now).getTime();
    const weekStart = startOfWeek(now).getTime();

    const todaySpans = allSpans.filter(s => s.startTimeMs >= todayStart);
    const weekSpans = allSpans.filter(s => s.startTimeMs >= weekStart);
    const sessionSpans = currentSessionId
      ? allSpans.filter(s => matchesSession(s, currentSessionId))
      : [];

    return {
      today: this.aggregatePeriod(todaySpans),
      thisWeek: this.aggregatePeriod(weekSpans),
      currentSession: {
        ...this.aggregatePeriod(sessionSpans),
        sessionId: currentSessionId,
      },
      last7Days: this.buildDailyBuckets(allSpans, now),
      recentSessions: this.buildRecentSessions(allSpans, sessionTitles),
      updatedAt: now.toISOString(),
    };
  }

  /**
   * Aggregate a set of spans into a PeriodCost with per-model breakdown.
   */
  aggregatePeriod(spans: Span[]): PeriodCost {
    const byModel = new Map<string, {
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      cacheWriteTokens: number;
    }>();

    for (const span of spans) {
      const model = span.responseModel ?? span.requestModel ?? 'unknown';
      const existing = byModel.get(model) ?? {
        calls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0,
      };
      existing.calls++;
      existing.inputTokens += span.inputTokens;
      existing.outputTokens += span.outputTokens;
      existing.cachedTokens += span.cachedTokens;
      existing.cacheWriteTokens += span.cacheWriteTokens;
      byModel.set(model, existing);
    }

    const modelCosts: ModelCost[] = [];
    let totalCost = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let totalCached = 0;

    for (const [model, data] of byModel) {
      const cost = this.calculator.calculate(
        model, data.inputTokens, data.outputTokens, data.cachedTokens, data.cacheWriteTokens
      );

      const modelCost: ModelCost = {
        model,
        calls: data.calls,
        inputTokens: data.inputTokens,
        outputTokens: data.outputTokens,
        cachedTokens: data.cachedTokens,
        cacheWriteTokens: data.cacheWriteTokens,
        freshInputCost: cost?.freshInputCost ?? 0,
        cacheReadCost: cost?.cacheReadCost ?? 0,
        cacheWriteCost: cost?.cacheWriteCost ?? 0,
        outputCost: cost?.outputCost ?? 0,
        totalCost: cost?.totalCost ?? 0,
      };

      modelCosts.push(modelCost);
      totalCost += modelCost.totalCost;
      totalInput += data.inputTokens;
      totalOutput += data.outputTokens;
      totalCached += data.cachedTokens;
    }

    return {
      totalCost,
      requests: spans.length,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedTokens: totalCached,
      byModel: modelCosts.sort((a, b) => b.totalCost - a.totalCost),
    };
  }

  /**
   * Build daily cost buckets for the last 7 days.
   */
  private buildDailyBuckets(spans: Span[], now: Date): DailyBucket[] {
    const buckets: DailyBucket[] = [];
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    for (let i = 6; i >= 0; i--) {
      const date = new Date(now);
      date.setDate(date.getDate() - i);
      const dayStart = startOfDay(date).getTime();
      const dayEnd = dayStart + 24 * 60 * 60 * 1000;

      const daySpans = spans.filter(s => s.startTimeMs >= dayStart && s.startTimeMs < dayEnd);
      const period = this.aggregatePeriod(daySpans);

      buckets.push({
        date: formatDate(date),
        dayLabel: dayNames[date.getDay()],
        totalCost: period.totalCost,
        requests: period.requests,
      });
    }

    return buckets;
  }

  /**
   * Build recent session summaries from spans.
   */
  private buildRecentSessions(spans: Span[], titles: Map<string, string>): SessionInfo[] {
    // Group spans by session
    const sessions = new Map<string, Span[]>();
    for (const span of spans) {
      const id = span.conversationId ?? span.chatSessionId ?? 'unknown';
      const existing = sessions.get(id) ?? [];
      existing.push(span);
      sessions.set(id, existing);
    }

    // Build session info sorted by most recent
    const sessionInfos: SessionInfo[] = [];
    for (const [sessionId, sessionSpans] of sessions) {
      const period = this.aggregatePeriod(sessionSpans);
      const startedAt = Math.min(...sessionSpans.map(s => s.startTimeMs));
      const endedAt = Math.max(...sessionSpans.map(s => s.endTimeMs));
      const primaryModel = period.byModel[0]?.model ?? null;

      sessionInfos.push({
        sessionId,
        title: titles.get(sessionId) ?? `Session ${sessionId.slice(0, 8)}`,
        model: primaryModel,
        agentName: null, // Enriched later by service layer
        startedAt,
        endedAt,
        totalCost: period.totalCost,
        requests: period.requests,
      });
    }

    return sessionInfos.sort((a, b) => b.endedAt - a.endedAt).slice(0, 20);
  }
}

// --- Helpers ---

function matchesSession(span: Span, sessionId: string): boolean {
  return span.chatSessionId === sessionId || span.conversationId === sessionId;
}

function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function startOfWeek(date: Date): Date {
  const d = startOfDay(date);
  const day = d.getDay();
  // Week starts on Monday
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
