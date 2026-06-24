import type {
  SessionInfo,
  SessionSnapshot,
  ModelCostSnapshot,
  WorkspaceCost,
  DailyAggregate,
} from './models.js';

/** Format a timestamp as local YYYY-MM-DD. */
export function localDateString(ms: number): string {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Convert a live SessionInfo into the trimmed snapshot stored in history. */
export function sessionInfoToSnapshot(s: SessionInfo): SessionSnapshot {
  return {
    sessionId: s.sessionId,
    title: s.title,
    workspace: s.workspace,
    totalCost: s.totalCost,
    modelTurns: s.modelTurns,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cachedTokens: s.cachedTokens,
    cacheWriteTokens: s.cacheWriteTokens,
    byModel: s.byModel.map(m => ({
      model: m.model,
      calls: m.calls,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cachedTokens: m.cachedTokens,
      cacheWriteTokens: m.cacheWriteTokens,
      totalCost: m.totalCost,
    })),
    startedAt: s.startedAt,
    endedAt: s.endedAt,
  };
}

/** Bucket sessions by the local calendar day of their start time. */
export function bucketSessionsByDay(sessions: SessionInfo[]): Map<string, SessionInfo[]> {
  const byDay = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const date = localDateString(s.startedAt);
    const bucket = byDay.get(date) ?? [];
    bucket.push(s);
    byDay.set(date, bucket);
  }
  return byDay;
}

/** Aggregate a set of per-session snapshots into a daily aggregate. */
export function aggregateSnapshots(date: string, sessions: SessionSnapshot[]): DailyAggregate {
  const modelMap = new Map<string, ModelCostSnapshot>();
  const workspaceMap = new Map<string, WorkspaceCost>();

  for (const session of sessions) {
    for (const m of session.byModel) {
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

    const ws = session.workspace ?? 'unknown';
    const wsEntry = workspaceMap.get(ws);
    if (wsEntry) {
      wsEntry.totalCost += session.totalCost;
      wsEntry.modelTurns += session.modelTurns;
      wsEntry.sessionCount += 1;
    } else {
      workspaceMap.set(ws, {
        workspace: ws,
        totalCost: session.totalCost,
        modelTurns: session.modelTurns,
        sessionCount: 1,
      });
    }
  }

  return {
    date,
    totalCost: sessions.reduce((sum, s) => sum + s.totalCost, 0),
    modelTurns: sessions.reduce((sum, s) => sum + s.modelTurns, 0),
    inputTokens: sessions.reduce((sum, s) => sum + s.inputTokens, 0),
    outputTokens: sessions.reduce((sum, s) => sum + s.outputTokens, 0),
    cachedTokens: sessions.reduce((sum, s) => sum + s.cachedTokens, 0),
    cacheWriteTokens: sessions.reduce((sum, s) => sum + s.cacheWriteTokens, 0),
    byModel: [...modelMap.values()].sort((a, b) => b.totalCost - a.totalCost),
    byWorkspace: [...workspaceMap.values()].sort((a, b) => b.totalCost - a.totalCost),
    sessionCount: sessions.length,
    sessions,
  };
}

/** Build a daily aggregate (with retained per-session snapshots) from live sessions. */
export function sessionsToDailyAggregate(date: string, sessions: SessionInfo[]): DailyAggregate {
  return aggregateSnapshots(date, sessions.map(sessionInfoToSnapshot));
}

/**
 * Merge an existing persisted daily aggregate with an incoming one, never letting
 * the persisted totals decrease (monotonic max-merge). This protects against the
 * source DB being partially cleaned between reads.
 *
 * When both sides carry per-session detail, sessions are unioned by id keeping the
 * richer (higher-cost) snapshot, then the daily aggregate is recomputed from the
 * union. When either side lacks per-session detail (e.g. a daily file written by an
 * older version), we fall back to keeping whichever whole aggregate has the higher
 * total cost.
 */
export function mergeDailyAggregates(
  existing: DailyAggregate | null,
  incoming: DailyAggregate
): DailyAggregate {
  if (!existing) return incoming;

  const exSessions = existing.sessions;
  const inSessions = incoming.sessions;

  if (exSessions && inSessions) {
    const byId = new Map<string, SessionSnapshot>();
    for (const s of exSessions) byId.set(s.sessionId, s);
    for (const s of inSessions) {
      const prev = byId.get(s.sessionId);
      // Keep the snapshot with the higher cost; on ties prefer the incoming
      // (fresher) one so token/model detail stays current.
      if (!prev || s.totalCost >= prev.totalCost) byId.set(s.sessionId, s);
    }
    return aggregateSnapshots(incoming.date, [...byId.values()]);
  }

  // No per-session detail on at least one side: keep the higher-cost aggregate,
  // preserving any per-session snapshots that do exist.
  const winner = incoming.totalCost >= existing.totalCost ? incoming : existing;
  return { ...winner, sessions: inSessions ?? exSessions };
}
