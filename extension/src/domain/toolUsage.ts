import type { ToolCall, ToolCallSpan, ToolUsageStat } from './models.js';
import { isSubagentSessionId } from './sessionIds.js';

/** Accumulate a stat into a tool-name keyed map. */
function accumulate(target: Map<string, ToolUsageStat>, stat: ToolUsageStat): void {
  const existing = target.get(stat.toolName);
  if (existing) {
    existing.calls += stat.calls;
    existing.errors += stat.errors;
    existing.totalDurationMs += stat.totalDurationMs;
    existing.totalCost += stat.totalCost;
  } else {
    target.set(stat.toolName, { ...stat });
  }
}

/** Sort by call count descending, then name, so UI ordering is stable. */
function sorted(map: Map<string, ToolUsageStat>): ToolUsageStat[] {
  return [...map.values()].sort(
    (a, b) => b.calls - a.calls || a.toolName.localeCompare(b.toolName)
  );
}

/** Merge several tool-usage lists into one additive distribution. */
export function sumToolUsage(lists: (ToolUsageStat[] | undefined)[]): ToolUsageStat[] {
  const map = new Map<string, ToolUsageStat>();
  for (const list of lists) {
    for (const stat of list ?? []) accumulate(map, stat);
  }
  return sorted(map);
}

/** Build a distribution from per-call data (session/turn detail). */
export function toolUsageFromCalls(calls: (ToolCall[] | undefined)[]): ToolUsageStat[] {
  const map = new Map<string, ToolUsageStat>();
  for (const list of calls) {
    for (const call of list ?? []) {
      accumulate(map, {
        toolName: call.toolName,
        calls: 1,
        errors: call.status === 'error' ? 1 : 0,
        totalDurationMs: Math.max(0, call.durationMs),
        totalCost: call.cost ?? 0,
      });
    }
  }
  return sorted(map);
}

/** Build a distribution from raw tool spans plus their attributed costs. */
export function toolUsageFromSpans(
  spans: ToolCallSpan[],
  costBySpanId: Map<string, number>
): ToolUsageStat[] {
  const map = new Map<string, ToolUsageStat>();
  for (const span of spans) {
    accumulate(map, {
      toolName: span.toolName,
      calls: 1,
      errors: span.statusCode === 2 ? 1 : 0,
      totalDurationMs: Math.max(0, span.endTimeMs - span.startTimeMs),
      totalCost: costBySpanId.get(span.spanId) ?? 0,
    });
  }
  return sorted(map);
}

/** Minimal shape needed to bind a tool call to the model call that requested it. */
interface Bindable {
  spanId: string;
  parentSpanId: string | null;
  startTimeMs: number;
}

/**
 * Bind tool calls to the model call that requested them. Grouping by parentSpanId
 * (the owning agent) keeps parallel subagents isolated; within an agent a tool
 * belongs to the most recent preceding model call.
 */
export function bindToolsToModelCalls<C extends Bindable, T extends Bindable>(
  modelCalls: C[],
  tools: T[]
): { bound: Map<string, T[]>; unbound: T[] } {
  const byParent = new Map<string, C[]>();
  for (const call of modelCalls) {
    const key = call.parentSpanId ?? '';
    const arr = byParent.get(key) ?? [];
    arr.push(call);
    byParent.set(key, arr);
  }
  for (const arr of byParent.values()) arr.sort((a, b) => a.startTimeMs - b.startTimeMs);

  const bound = new Map<string, T[]>();
  const unbound: T[] = [];
  for (const tool of tools) {
    const candidates = byParent.get(tool.parentSpanId ?? '') ?? [];
    let chosen: C | null = null;
    for (const c of candidates) {
      if (c.startTimeMs <= tool.startTimeMs) chosen = c;
      else break;
    }
    if (chosen) {
      const arr = bound.get(chosen.spanId) ?? [];
      arr.push(tool);
      bound.set(chosen.spanId, arr);
    } else {
      unbound.push(tool);
    }
  }
  return { bound, unbound };
}

/**
 * Split each model call's cost evenly across the tool calls it requested.
 * Returns tool span id → attributed cost.
 */
export function attributeToolCosts<C extends Bindable, T extends Bindable>(
  modelCalls: C[],
  tools: T[],
  costOf: (call: C) => number
): Map<string, number> {
  const byId = new Map<string, C>();
  for (const call of modelCalls) byId.set(call.spanId, call);

  const { bound } = bindToolsToModelCalls(modelCalls, tools);
  const costs = new Map<string, number>();
  for (const [callSpanId, boundTools] of bound) {
    const call = byId.get(callSpanId);
    if (!call || boundTools.length === 0) continue;
    const share = costOf(call) / boundTools.length;
    for (const tool of boundTools) costs.set(tool.spanId, share);
  }
  return costs;
}

/**
 * Resolve the owning chat session for a tool span. Subagent tool calls carry a
 * tool-call id (`toolu_`/`call_`) as their session, so they are mapped back to the
 * real session via the trace id shared by every span in a turn.
 */
export function resolveToolSpanSession(
  span: ToolCallSpan,
  traceToSession: Map<string, string>
): string | null {
  if (span.chatSessionId && !isSubagentSessionId(span.chatSessionId)) return span.chatSessionId;
  const parent = traceToSession.get(span.traceId);
  if (parent) return parent;
  if (span.conversationId && !isSubagentSessionId(span.conversationId)) return span.conversationId;
  return null;
}

/** Group tool spans by resolved session id, dropping unattributable ones. */
export function groupToolSpansBySession(
  spans: ToolCallSpan[],
  traceToSession: Map<string, string>
): Map<string, ToolCallSpan[]> {
  const bySession = new Map<string, ToolCallSpan[]>();
  for (const span of spans) {
    const sessionId = resolveToolSpanSession(span, traceToSession);
    if (!sessionId) continue;
    const bucket = bySession.get(sessionId) ?? [];
    bucket.push(span);
    bySession.set(sessionId, bucket);
  }
  return bySession;
}

/** Average duration per call, rounded; 0 when the tool has no calls. */
export function avgDurationMs(stat: ToolUsageStat): number {
  return stat.calls > 0 ? Math.round(stat.totalDurationMs / stat.calls) : 0;
}

/** Total number of calls across a distribution. */
export function totalToolCalls(stats: ToolUsageStat[] | undefined): number {
  return (stats ?? []).reduce((n, s) => n + s.calls, 0);
}

/** Total attributed cost across a distribution. */
export function totalToolCost(stats: ToolUsageStat[] | undefined): number {
  return (stats ?? []).reduce((n, s) => n + s.totalCost, 0);
}
