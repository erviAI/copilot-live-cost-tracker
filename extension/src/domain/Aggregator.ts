import type { Span, ModelCost, PeriodCost, DailyBucket, SessionInfo, DashboardData, SessionDetailData, TurnCost, ModelDetailBreakdown, SpanDetail } from './models.js';
import { CostCalculator } from './CostCalculator.js';
import { isIgnoredAgent } from './filters.js';

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
    currentSessionId: string | null,
    sessionRepositories?: Map<string, string | null>
  ): DashboardData {
    const now = new Date();
    const todayStart = startOfDay(now).getTime();
    const weekStart = startOfWeek(now).getTime();

    const todaySpans = allSpans.filter(s => s.startTimeMs >= todayStart);
    const weekSpans = allSpans.filter(s => s.startTimeMs >= weekStart);
    const sessionSpans = currentSessionId
      ? allSpans.filter(s => matchesSession(s, currentSessionId))
      : [];

    let latestSpanTimeMs: number | null = null;
    let agentName: string | null = null;
    for (const s of sessionSpans) {
      if (latestSpanTimeMs === null || s.startTimeMs > latestSpanTimeMs) {
        latestSpanTimeMs = s.startTimeMs;
        agentName = s.agentName ?? agentName;
      }
    }

    return {
      today: this.aggregatePeriod(todaySpans),
      thisWeek: this.aggregatePeriod(weekSpans),
      currentSession: {
        ...this.aggregatePeriod(sessionSpans),
        sessionId: currentSessionId,
        title: currentSessionId ? (sessionTitles.get(currentSessionId) ?? null) : null,
        agentName,
        latestSpanTimeMs,
        spanCount: sessionSpans.length,
      },
      last7Days: this.buildDailyBuckets(allSpans, now),
      recentSessions: this.buildRecentSessions(allSpans, sessionTitles, sessionRepositories),
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
  private buildRecentSessions(spans: Span[], titles: Map<string, string>, repositories?: Map<string, string | null>): SessionInfo[] {
    // Only include spans that belong to a real chat session (have chat_session_id).
    // Spans with only conversation_id are background/inline completions, not user sessions.
    // Also exclude spans from ignored utility agents (e.g. copilotLanguageModelWrapper).
    const chatSpans = spans.filter(s => s.chatSessionId !== null && !isIgnoredAgent(s));
    const conversationToChat = buildConversationToChatMap(chatSpans);

    // Build trace_id → real session ID map for resolving subagent spans.
    // All spans in a turn share trace_id; parent spans have a real UUID chatSessionId.
    const traceToSession = new Map<string, string>();
    for (const span of chatSpans) {
      if (span.chatSessionId && !isToolCallSessionId(span.chatSessionId)) {
        if (!traceToSession.has(span.traceId)) {
          traceToSession.set(span.traceId, span.chatSessionId);
        }
      }
    }

    // Group spans by session
    const sessions = new Map<string, Span[]>();
    for (const span of chatSpans) {
      const id = getCanonicalSessionId(span, conversationToChat, traceToSession);
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
        repository: repositories?.get(sessionId) ?? null,
        startedAt,
        endedAt,
        totalCost: period.totalCost,
        requests: period.requests,
      });
    }

    return sessionInfos.sort((a, b) => b.endedAt - a.endedAt).slice(0, 20);
  }

  /**
   * Aggregate session detail: per-turn costs and per-model breakdown with rate.
   */
  aggregateSessionDetail(sessionId: string, spans: Span[]): SessionDetailData {
    // --- Per-turn breakdown ---
    // Prefer turnIndex for grouping; fall back to traceId when turnIndex is unavailable
    const hasTurnIndex = spans.some(s => s.turnIndex != null && s.turnIndex >= 0);

    const turnMap = new Map<string, Span[]>();
    for (const span of spans) {
      const key = hasTurnIndex
        ? String(span.turnIndex ?? -1)
        : (span.traceId ?? 'unknown');
      const arr = turnMap.get(key) ?? [];
      arr.push(span);
      turnMap.set(key, arr);
    }

    const turns: TurnCost[] = [];
    let turnCounter = 0;
    // Sort by earliest span start time within each group
    const sortedGroups = [...turnMap.entries()].sort((a, b) => {
      const aStart = Math.min(...a[1].map(s => s.startTimeMs));
      const bStart = Math.min(...b[1].map(s => s.startTimeMs));
      return aStart - bStart;
    });

    for (const [key, turnSpans] of sortedGroups) {
      const turnIndex = hasTurnIndex ? Number(key) : turnCounter++;
      const traceId = hasTurnIndex ? (turnSpans[0]?.traceId ?? key) : key;
      const period = this.aggregatePeriod(turnSpans);
      const durationMs = turnSpans.reduce((sum, s) => sum + (s.endTimeMs - s.startTimeMs), 0);

      const spanDetails: SpanDetail[] = turnSpans.map(s => {
        const model = s.responseModel ?? s.requestModel ?? 'unknown';
        const cost = this.calculator.calculate(model, s.inputTokens, s.outputTokens, s.cachedTokens, s.cacheWriteTokens);
        return {
          traceId: s.traceId,
          agentName: s.agentName,
          model,
          inputTokens: s.inputTokens,
          outputTokens: s.outputTokens,
          cachedTokens: s.cachedTokens,
          cacheWriteTokens: s.cacheWriteTokens,
          totalCost: cost?.totalCost ?? 0,
          durationMs: s.endTimeMs - s.startTimeMs,
        };
      });

      turns.push({
        turnIndex,
        traceId,
        agentName: turnSpans[0]?.agentName ?? null,
        model: turnSpans[0]?.responseModel ?? turnSpans[0]?.requestModel ?? null,
        startTimeMs: Math.min(...turnSpans.map(s => s.startTimeMs)),
        llmCalls: period.requests,
        inputTokens: period.inputTokens,
        outputTokens: period.outputTokens,
        cachedTokens: period.cachedTokens,
        cacheWriteTokens: period.byModel.reduce((s, m) => s + m.cacheWriteTokens, 0),
        totalCost: period.totalCost,
        durationMs,
        spans: spanDetails,
      });
    }

    // --- Per-model breakdown with rate ---
    const period = this.aggregatePeriod(spans);
    const modelDurations = new Map<string, number>();
    for (const span of spans) {
      const model = span.responseModel ?? span.requestModel ?? 'unknown';
      modelDurations.set(model, (modelDurations.get(model) ?? 0) + (span.endTimeMs - span.startTimeMs));
    }

    const byModel: ModelDetailBreakdown[] = period.byModel.map(mc => {
      const totalDurMs = modelDurations.get(mc.model) ?? 0;
      const totalDurSec = totalDurMs / 1000;
      const rateTokensPerSec = totalDurSec > 0 ? Math.round(mc.outputTokens / totalDurSec) : 0;
      const cacheHitPct = mc.inputTokens > 0 ? Math.round(100 * mc.cachedTokens / mc.inputTokens) : 0;
      return {
        ...mc,
        avgDurationMs: mc.calls > 0 ? Math.round(totalDurMs / mc.calls) : 0,
        rateTokensPerSec,
        cacheHitPct,
      };
    });

    return {
      sessionId,
      turns,
      byModel,
      totalCost: period.totalCost,
      totalLlmCalls: period.requests,
    };
  }
}

// --- Helpers ---

function matchesSession(span: Span, sessionId: string): boolean {
  return span.chatSessionId === sessionId || span.conversationId === sessionId;
}

function getCanonicalSessionId(span: Span, _conversationToChat: Map<string, string>, traceToSession: Map<string, string>): string {
  // Subagent spans have chatSessionId set to a tool-call ID (e.g. "toolu_bdrk_...").
  // Use trace_id to resolve back to the real parent session, since all spans in a
  // turn share the same trace_id.
  if (span.chatSessionId && isToolCallSessionId(span.chatSessionId)) {
    const parentSession = traceToSession.get(span.traceId);
    if (parentSession) return parentSession;
    // Fallback: if no parent found via trace, use conversationId or chatSessionId
    return span.conversationId ?? span.chatSessionId;
  }
  if (span.chatSessionId) return span.chatSessionId;
  if (span.conversationId) return _conversationToChat.get(span.conversationId) ?? span.conversationId;
  return 'unknown';
}

/** Returns true if the session ID looks like a tool-call ID (subagent invocation). */
function isToolCallSessionId(id: string): boolean {
  return id.startsWith('toolu_');
}

function buildConversationToChatMap(spans: Span[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const span of spans) {
    if (span.conversationId && span.chatSessionId && !map.has(span.conversationId)) {
      map.set(span.conversationId, span.chatSessionId);
    }
  }
  return map;
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
