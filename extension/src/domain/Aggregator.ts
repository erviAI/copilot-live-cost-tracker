import type { Span, ModelCost, PeriodCost, DailyBucket, SessionInfo, DashboardData, SessionDetailData, TurnCost, ModelDetailBreakdown, SpanDetail, WorkspaceCost, ToolCall, TurnText } from './models.js';
import { CostCalculator } from './CostCalculator.js';
import { isIgnoredAgent } from './filters.js';
import { isSubagentSessionId } from './sessionIds.js';

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
    sessionWorkspaces?: Map<string, string | null>
  ): DashboardData {
    const now = new Date();
    const todayStart = startOfDay(now).getTime();
    const weekStart = startOfWeek(now).getTime();

    const todaySpans = allSpans.filter(s => s.startTimeMs >= todayStart);
    const weekSpans = allSpans.filter(s => s.startTimeMs >= weekStart);

    let sessionSpans: Span[];
    if (!currentSessionId) {
      sessionSpans = [];
    } else {
      // First pass: collect direct matches and traceIds that belong to this session
      const directMatches: Span[] = [];
      const sessionTraceIds = new Set<string>();
      const pendingSubagent: Span[] = [];

      for (const span of allSpans) {
        if (matchesSession(span, currentSessionId)) {
          directMatches.push(span);
          sessionTraceIds.add(span.traceId);
        } else if (span.chatSessionId && isToolCallSessionId(span.chatSessionId)) {
          pendingSubagent.push(span);
        }
      }

      // Second pass: include sub-agent spans whose traceId belongs to this session
      sessionSpans = directMatches;
      for (const span of pendingSubagent) {
        if (sessionTraceIds.has(span.traceId)) {
          sessionSpans.push(span);
        }
      }
    }

    let latestSpanTimeMs: number | null = null;
    let agentName: string | null = null;
    for (const s of sessionSpans) {
      if (latestSpanTimeMs === null || s.startTimeMs > latestSpanTimeMs) {
        latestSpanTimeMs = s.startTimeMs;
        agentName = s.agentName ?? agentName;
      }
    }

    return {
      today: this.aggregatePeriod(todaySpans, sessionWorkspaces),
      thisWeek: this.aggregatePeriod(weekSpans, sessionWorkspaces),
      currentSession: {
        ...this.aggregatePeriod(sessionSpans),
        sessionId: currentSessionId,
        title: currentSessionId ? (sessionTitles.get(currentSessionId) ?? null) : null,
        agentName,
        workspace: currentSessionId ? (sessionWorkspaces?.get(currentSessionId) ?? null) : null,
        latestSpanTimeMs,
        spanCount: sessionSpans.length,
        contextWeightTokens: computeContextWeight(sessionSpans),
      },
      last7Days: this.buildDailyBuckets(allSpans, now),
      recentSessions: this.buildRecentSessions(allSpans, sessionTitles, sessionWorkspaces),
      updatedAt: now.toISOString(),
    };
  }

  /**
   * Aggregate a set of spans into a PeriodCost with per-model and per-workspace breakdown.
   */
  aggregatePeriod(spans: Span[], sessionWorkspaces?: Map<string, string | null>): PeriodCost {
    const byModel = new Map<string, {
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      cacheWriteTokens: number;
    }>();

    // Workspace accumulator: workspace → { requests, sessionIds, per-model token totals }.
    // Costs are derived once from the aggregated per-model token totals (below) so
    // workspace totals use the exact same rounding path as the per-model totals.
    type WsTokens = { inputTokens: number; outputTokens: number; cachedTokens: number; cacheWriteTokens: number };
    const byWs = new Map<string, { requests: number; sessionIds: Set<string>; byModel: Map<string, WsTokens> }>();
    const traceToSession = buildTraceToSessionMap(spans);

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

      // Accumulate per-workspace token totals if mapping provided
      if (sessionWorkspaces) {
        const sessionId = getWorkspaceSessionId(span, traceToSession);
        const ws = (sessionId ? sessionWorkspaces.get(sessionId) : null) ?? 'Unknown';
        const wsEntry = byWs.get(ws) ?? { requests: 0, sessionIds: new Set<string>(), byModel: new Map<string, WsTokens>() };
        wsEntry.requests++;
        if (sessionId) { wsEntry.sessionIds.add(sessionId); }
        const wsModel = wsEntry.byModel.get(model) ?? { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
        wsModel.inputTokens += span.inputTokens;
        wsModel.outputTokens += span.outputTokens;
        wsModel.cachedTokens += span.cachedTokens;
        wsModel.cacheWriteTokens += span.cacheWriteTokens;
        wsEntry.byModel.set(model, wsModel);
        byWs.set(ws, wsEntry);
      }
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
        estimated: cost?.estimated ?? false,
        unpriced: cost === null,
      };

      modelCosts.push(modelCost);
      totalCost += modelCost.totalCost;
      totalInput += data.inputTokens;
      totalOutput += data.outputTokens;
      totalCached += data.cachedTokens;
    }

    // Build workspace costs from the aggregated per-model token totals so they
    // are consistent with the per-model costs above (one rounding path, and one
    // calculate() call per workspace+model group rather than per span).
    const workspaceCosts: WorkspaceCost[] = [];
    for (const [workspace, data] of byWs) {
      let wsTotal = 0;
      for (const [model, tokens] of data.byModel) {
        const cost = this.calculator.calculate(
          model, tokens.inputTokens, tokens.outputTokens, tokens.cachedTokens, tokens.cacheWriteTokens
        );
        wsTotal += cost?.totalCost ?? 0;
      }
      workspaceCosts.push({
        workspace,
        totalCost: wsTotal,
        modelTurns: data.requests,
        sessionCount: data.sessionIds.size,
      });
    }
    workspaceCosts.sort((a, b) => b.totalCost - a.totalCost);

    return {
      totalCost,
      modelTurns: spans.length,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cachedTokens: totalCached,
      byModel: modelCosts.sort((a, b) => b.totalCost - a.totalCost),
      byWorkspace: workspaceCosts,
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
        modelTurns: period.modelTurns,
      });
    }

    return buckets;
  }

  /**
   * Build session summaries from spans (uncapped). Used by the history layer to
   * persist every session in the window, not just the most recent ones.
   */
  buildSessions(spans: Span[], titles: Map<string, string>, workspaces?: Map<string, string | null>): SessionInfo[] {
    return this.buildRecentSessions(spans, titles, workspaces, Infinity);
  }

  /**
   * Build recent session summaries from spans.
   * @param limit Maximum number of (most recent) sessions to return.
   */
  private buildRecentSessions(spans: Span[], titles: Map<string, string>, workspaces?: Map<string, string | null>, limit = 20): SessionInfo[] {
    // Only include spans that belong to a real chat session (have chat_session_id).
    // Spans with only conversation_id are background/inline completions, not user sessions.
    // Also exclude spans from ignored utility agents (e.g. copilotLanguageModelWrapper).
    const chatSpans = spans.filter(s => s.chatSessionId !== null && !isIgnoredAgent(s));
    const conversationToChat = buildConversationToChatMap(chatSpans);

    // Build trace_id → real session ID map for resolving subagent spans.
    // All spans in a turn share trace_id; parent spans have a real UUID chatSessionId.
    const traceToSession = buildTraceToSessionMap(chatSpans);

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
        workspace: workspaces?.get(sessionId) ?? null,
        startedAt,
        endedAt,
        totalCost: period.totalCost,
        modelTurns: period.modelTurns,
        inputTokens: period.inputTokens,
        outputTokens: period.outputTokens,
        cachedTokens: period.cachedTokens,
        cacheWriteTokens: period.byModel.reduce((sum, m) => sum + m.cacheWriteTokens, 0),
        byModel: period.byModel,
      });
    }

    return sessionInfos.sort((a, b) => b.endedAt - a.endedAt).slice(0, limit);
  }

  /**
   * Aggregate session detail: per-turn costs and per-model breakdown with rate.
   * @param turnLabels Map of traceId → user prompt label (from agent-traces.db)
   */
  /**
   * Bind tool/function calls to the model (chat) call that requested them.
   * Grouping by parentSpanId (owning agent) keeps parallel subagents isolated;
   * within an agent a tool is attributed to the most recent preceding chat call.
   * Mutates the matched SpanDetail.toolCalls and returns any unbound tool calls.
   */
  private bindToolCallsToSpans(
    chatSpans: Span[],
    toolCalls: ToolCall[],
    detailById: Map<string, SpanDetail>
  ): ToolCall[] {
    const byParent = new Map<string, Span[]>();
    for (const s of chatSpans) {
      const k = s.parentSpanId ?? '';
      const arr = byParent.get(k) ?? [];
      arr.push(s);
      byParent.set(k, arr);
    }
    for (const arr of byParent.values()) arr.sort((a, b) => a.startTimeMs - b.startTimeMs);

    const unbound: ToolCall[] = [];
    for (const tool of toolCalls) {
      const candidates = byParent.get(tool.parentSpanId ?? '') ?? [];
      let chosen: Span | null = null;
      for (const c of candidates) {
        if (c.startTimeMs <= tool.startTimeMs) chosen = c;
        else break;
      }
      const detail = chosen ? detailById.get(chosen.spanId) : undefined;
      if (detail) {
        (detail.toolCalls ??= []).push(tool);
      } else {
        unbound.push(tool);
      }
    }
    for (const d of detailById.values()) d.toolCalls?.sort((a, b) => a.startTimeMs - b.startTimeMs);
    return unbound;
  }

  aggregateSessionDetail(sessionId: string, spans: Span[], turnLabels?: Map<string, string>, toolSpans?: Span[], turnTexts?: Map<number, TurnText>): SessionDetailData {
    // --- Tool/function calls grouped by trace (turn) ---
    const toolCallsByTrace = new Map<string, ToolCall[]>();
    for (const s of toolSpans ?? []) {
      if (!s.toolName) continue;
      const arr = toolCallsByTrace.get(s.traceId) ?? [];
      arr.push({
        spanId: s.spanId,
        traceId: s.traceId,
        parentSpanId: s.parentSpanId,
        toolName: s.toolName,
        operationName: s.operationName,
        agentName: s.agentName,
        startTimeMs: s.startTimeMs,
        durationMs: Math.max(0, s.endTimeMs - s.startTimeMs),
        status: s.statusCode === 2 ? 'error' : 'ok',
        args: s.toolArgs ?? null,
        result: s.toolResult ?? null,
        statusMessage: s.statusMessage ?? null,
      });
      toolCallsByTrace.set(s.traceId, arr);
    }
    for (const arr of toolCallsByTrace.values()) arr.sort((a, b) => a.startTimeMs - b.startTimeMs);

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

      // Split spans into parent and subagent groups
      const parentSpans: Span[] = [];
      const subagentGroups = new Map<string, Span[]>();
      for (const span of turnSpans) {
        if (span.chatSessionId && isToolCallSessionId(span.chatSessionId)) {
          const arr = subagentGroups.get(span.chatSessionId) ?? [];
          arr.push(span);
          subagentGroups.set(span.chatSessionId, arr);
        } else {
          parentSpans.push(span);
        }
      }

      // Build child turns for each subagent group
      const children: TurnCost[] = [];
      const allSubDetails: SpanDetail[] = [];
      for (const [_subSessionId, subSpans] of subagentGroups) {
        const subPeriod = this.aggregatePeriod(subSpans);
        const subDuration = subSpans.reduce((sum, s) => sum + (s.endTimeMs - s.startTimeMs), 0);
        const subSpanDetails: SpanDetail[] = subSpans.map(s => {
          const model = s.responseModel ?? s.requestModel ?? 'unknown';
          const cost = this.calculator.calculate(model, s.inputTokens, s.outputTokens, s.cachedTokens, s.cacheWriteTokens);
          return {
            spanId: s.spanId, traceId: s.traceId, agentName: s.agentName, model,
            inputTokens: s.inputTokens, outputTokens: s.outputTokens,
            cachedTokens: s.cachedTokens, cacheWriteTokens: s.cacheWriteTokens,
            reasoningTokens: s.reasoningTokens,
            totalCost: cost?.totalCost ?? 0, durationMs: s.endTimeMs - s.startTimeMs,
            startTimeMs: s.startTimeMs, operationName: s.operationName, toolName: s.toolName,
          };
        });
        allSubDetails.push(...subSpanDetails);
        children.push({
          turnIndex,
          traceId,
          label: null,
          agentName: subSpans[0]?.agentName ?? null,
          model: subSpans[0]?.responseModel ?? subSpans[0]?.requestModel ?? null,
          startTimeMs: Math.min(...subSpans.map(s => s.startTimeMs)),
          llmCalls: subPeriod.modelTurns,
          inputTokens: subPeriod.inputTokens,
          outputTokens: subPeriod.outputTokens,
          cachedTokens: subPeriod.cachedTokens,
          cacheWriteTokens: subPeriod.byModel.reduce((s, m) => s + m.cacheWriteTokens, 0),
          totalCost: subPeriod.totalCost,
          durationMs: subDuration,
          spans: subSpanDetails,
        });
      }
      // Sort children by start time
      children.sort((a, b) => a.startTimeMs - b.startTimeMs);

      // Use all spans for the parent turn totals (includes subagent costs)
      const period = this.aggregatePeriod(turnSpans);
      const durationMs = turnSpans.reduce((sum, s) => sum + (s.endTimeMs - s.startTimeMs), 0);

      const spanDetails: SpanDetail[] = parentSpans.map(s => {
        const model = s.responseModel ?? s.requestModel ?? 'unknown';
        const cost = this.calculator.calculate(model, s.inputTokens, s.outputTokens, s.cachedTokens, s.cacheWriteTokens);
        return {
          spanId: s.spanId, traceId: s.traceId, agentName: s.agentName, model,
          inputTokens: s.inputTokens, outputTokens: s.outputTokens,
          cachedTokens: s.cachedTokens, cacheWriteTokens: s.cacheWriteTokens,
          reasoningTokens: s.reasoningTokens,
          totalCost: cost?.totalCost ?? 0, durationMs: s.endTimeMs - s.startTimeMs,
          startTimeMs: s.startTimeMs, operationName: s.operationName, toolName: s.toolName,
        };
      });

      // Resolve turn label from user prompt (keyed by traceId)
      const label = turnLabels?.get(traceId) ?? null;
      // Resolve full prompt/response text (keyed by turnIndex) when available.
      const text = turnTexts?.get(turnIndex);

      // Bind each tool/function call to the model call that requested it.
      // Scope by parentSpanId (the owning agent) so parallel subagents never
      // cross-attribute; within an agent, a tool belongs to the most recent
      // preceding chat call. Tools with no matching model call stay at turn level.
      const detailById = new Map<string, SpanDetail>();
      for (const d of spanDetails) detailById.set(d.spanId, d);
      for (const d of allSubDetails) detailById.set(d.spanId, d);
      const unboundTools = this.bindToolCallsToSpans(
        turnSpans, toolCallsByTrace.get(traceId) ?? [], detailById
      );

      turns.push({
        turnIndex,
        traceId,
        label,
        agentName: parentSpans[0]?.agentName ?? turnSpans[0]?.agentName ?? null,
        model: parentSpans[0]?.responseModel ?? parentSpans[0]?.requestModel ?? turnSpans[0]?.responseModel ?? turnSpans[0]?.requestModel ?? null,
        startTimeMs: Math.min(...turnSpans.map(s => s.startTimeMs)),
        llmCalls: period.modelTurns,
        inputTokens: period.inputTokens,
        outputTokens: period.outputTokens,
        cachedTokens: period.cachedTokens,
        cacheWriteTokens: period.byModel.reduce((s, m) => s + m.cacheWriteTokens, 0),
        totalCost: period.totalCost,
        durationMs,
        spans: spanDetails,
        children: children.length > 0 ? children : undefined,
        toolCalls: unboundTools.length > 0 ? unboundTools : undefined,
        promptText: text?.userMessage ?? null,
        responseText: text?.assistantResponse ?? null,
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
      totalLlmCalls: period.modelTurns,
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

function getWorkspaceSessionId(span: Span, traceToSession: Map<string, string>): string | null {
  if (span.chatSessionId && isToolCallSessionId(span.chatSessionId)) {
    return traceToSession.get(span.traceId) ?? span.conversationId ?? span.chatSessionId;
  }
  return span.chatSessionId ?? span.conversationId;
}

function buildTraceToSessionMap(spans: Span[]): Map<string, string> {
  const traceToSession = new Map<string, string>();
  for (const span of spans) {
    if (span.chatSessionId && !isToolCallSessionId(span.chatSessionId) && !traceToSession.has(span.traceId)) {
      traceToSession.set(span.traceId, span.chatSessionId);
    }
  }
  return traceToSession;
}

/** Returns true if the session ID looks like a tool-call ID (subagent invocation). */
function isToolCallSessionId(id: string): boolean {
  return isSubagentSessionId(id);
}

/**
 * Compute the live context weight for a session: the total prompt size (input
 * tokens, which already include any cached tokens per gen_ai usage semantics)
 * of the most recent turn. All spans in a turn share a traceId; we take the
 * largest prompt among the latest turn's spans, which corresponds to the main
 * model call carrying the full conversation context.
 */
function computeContextWeight(sessionSpans: Span[]): number {
  if (sessionSpans.length === 0) return 0;

  let latestTraceId = sessionSpans[0].traceId;
  let latestTimeMs = sessionSpans[0].startTimeMs;
  for (const s of sessionSpans) {
    if (s.startTimeMs > latestTimeMs) {
      latestTimeMs = s.startTimeMs;
      latestTraceId = s.traceId;
    }
  }

  let weight = 0;
  for (const s of sessionSpans) {
    if (s.traceId === latestTraceId) {
      const prompt = s.inputTokens;
      if (prompt > weight) weight = prompt;
    }
  }
  return weight;
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
