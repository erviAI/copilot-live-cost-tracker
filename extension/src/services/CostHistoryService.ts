import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  DashboardData,
  SessionInfo,
  CurrentDayData,
  DailyAggregate,
  SessionSnapshot,
  ModelCostSnapshot,
  WorkspaceCost,
} from '../domain/models.js';

/**
 * CostHistoryService persists aggregated cost data to JSON files so that
 * historical totals survive agent-traces.db resets.
 *
 * File layout (inside globalStorage):
 *   cost-history/
 *     current.json        — today's per-session snapshots
 *     daily/
 *       YYYY-MM-DD.json   — rolled-up daily aggregates
 */
export class CostHistoryService {
  private readonly historyDir: string;
  private readonly dailyDir: string;
  private readonly currentPath: string;
  private initialized = false;

  constructor(
    globalStoragePath: string,
    private readonly getRetentionDays: () => number
  ) {
    this.historyDir = path.join(globalStoragePath, 'cost-history');
    this.dailyDir = path.join(this.historyDir, 'daily');
    this.currentPath = path.join(this.historyDir, 'current.json');
  }

  /** Ensure directories exist. Called lazily on first write. */
  private async ensureDirectories(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.dailyDir, { recursive: true });
    this.initialized = true;
  }

  /**
   * Main entry point: scrape the current dashboard data into history files.
   * Called periodically by CostTrackingService.
   */
  async scrape(data: DashboardData): Promise<void> {
    try {
      await this.ensureDirectories();

      const today = localDateString(Date.now());

      // Check if a day rollover happened
      const existing = await this.readCurrentDay();
      if (existing && existing.date !== today) {
        await this.rollup(existing);
      }

      // Build today's session snapshots from dashboard data
      const sessions = this.buildSessionSnapshots(data, today);
      const currentDay: CurrentDayData = {
        date: today,
        lastUpdatedAt: new Date().toISOString(),
        sessions,
      };

      await this.atomicWrite(this.currentPath, currentDay);
    } catch (err) {
      console.error('[CopilotCostTracker] History scrape error:', err);
    }
  }

  /**
   * Check if a rollup is needed (e.g. on activation after being offline overnight).
   */
  async checkRollup(): Promise<void> {
    try {
      const existing = await this.readCurrentDay();
      if (existing && existing.date !== localDateString(Date.now())) {
        await this.ensureDirectories();
        await this.rollup(existing);
      }
    } catch (err) {
      console.error('[CopilotCostTracker] History rollup check error:', err);
    }
  }

  /**
   * Delete daily files older than retention period.
   */
  async prune(): Promise<void> {
    try {
      const retentionDays = this.getRetentionDays();
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - retentionDays);
      const cutoffStr = localDateString(cutoff.getTime());

      let entries: string[];
      try {
        entries = await fs.readdir(this.dailyDir);
      } catch {
        return; // Directory doesn't exist yet
      }

      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const date = entry.replace('.json', '');
        if (date < cutoffStr) {
          await fs.unlink(path.join(this.dailyDir, entry));
          console.log(`[CopilotCostTracker] Pruned history file: ${entry}`);
        }
      }
    } catch (err) {
      console.error('[CopilotCostTracker] History prune error:', err);
    }
  }

  /**
   * Read all daily aggregates for the past N days (for future UI use).
   */
  async getHistory(days?: number): Promise<DailyAggregate[]> {
    const limit = days ?? this.getRetentionDays();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - limit);
    const cutoffStr = localDateString(cutoff.getTime());

    let entries: string[];
    try {
      entries = await fs.readdir(this.dailyDir);
    } catch {
      return [];
    }

    const results: DailyAggregate[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const date = entry.replace('.json', '');
      if (date < cutoffStr) continue;
      try {
        const content = await fs.readFile(path.join(this.dailyDir, entry), 'utf-8');
        results.push(JSON.parse(content));
      } catch {
        // Skip corrupt files
      }
    }
    return results;
  }

  /**
   * Get the current day's data (for combining with daily history).
   */
  async getCurrentDay(): Promise<CurrentDayData | null> {
    return this.readCurrentDay();
  }

  // --- Private Helpers ---

  private buildSessionSnapshots(data: DashboardData, today: string): SessionSnapshot[] {
    // Use recentSessions from dashboard, filter to today only
    const todaySessions = data.recentSessions.filter(s => {
      const sessionDate = localDateString(s.startedAt);
      return sessionDate === today;
    });

    return todaySessions.map(s => this.sessionInfoToSnapshot(s));
  }

  private sessionInfoToSnapshot(s: SessionInfo): SessionSnapshot {
    // SessionInfo doesn't have byModel or full token breakdowns at the top level,
    // so we capture what's available. The dashboard's today PeriodCost has byModel
    // but it's aggregated across sessions. Per-session detail needs to come from
    // the session info fields available.
    return {
      sessionId: s.sessionId,
      title: s.title,
      workspace: s.workspace,
      totalCost: s.totalCost,
      requests: s.requests,
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

  private async rollup(currentDay: CurrentDayData): Promise<void> {
    const { date, sessions } = currentDay;

    // Aggregate by model
    const modelMap = new Map<string, ModelCostSnapshot>();
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
    }

    // Aggregate by workspace
    const workspaceMap = new Map<string, WorkspaceCost>();
    for (const session of sessions) {
      const ws = session.workspace ?? 'unknown';
      const existing = workspaceMap.get(ws);
      if (existing) {
        existing.totalCost += session.totalCost;
        existing.requests += session.requests;
        existing.sessionCount += 1;
      } else {
        workspaceMap.set(ws, {
          workspace: ws,
          totalCost: session.totalCost,
          requests: session.requests,
          sessionCount: 1,
        });
      }
    }

    const aggregate: DailyAggregate = {
      date,
      totalCost: sessions.reduce((sum, s) => sum + s.totalCost, 0),
      requests: sessions.reduce((sum, s) => sum + s.requests, 0),
      inputTokens: sessions.reduce((sum, s) => sum + s.inputTokens, 0),
      outputTokens: sessions.reduce((sum, s) => sum + s.outputTokens, 0),
      cachedTokens: sessions.reduce((sum, s) => sum + s.cachedTokens, 0),
      cacheWriteTokens: sessions.reduce((sum, s) => sum + s.cacheWriteTokens, 0),
      byModel: [...modelMap.values()].sort((a, b) => b.totalCost - a.totalCost),
      byWorkspace: [...workspaceMap.values()].sort((a, b) => b.totalCost - a.totalCost),
      sessionCount: sessions.length,
    };

    const dailyPath = path.join(this.dailyDir, `${date}.json`);
    await this.atomicWrite(dailyPath, aggregate);

    // Reset current.json for the new day
    const fresh: CurrentDayData = {
      date: localDateString(Date.now()),
      lastUpdatedAt: new Date().toISOString(),
      sessions: [],
    };
    await this.atomicWrite(this.currentPath, fresh);

    console.log(`[CopilotCostTracker] Rolled up ${sessions.length} sessions for ${date}`);
  }

  private async readCurrentDay(): Promise<CurrentDayData | null> {
    try {
      const content = await fs.readFile(this.currentPath, 'utf-8');
      return JSON.parse(content) as CurrentDayData;
    } catch {
      return null;
    }
  }

  private async atomicWrite(filePath: string, data: unknown): Promise<void> {
    const tmp = filePath + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
    await fs.rename(tmp, filePath);
  }
}

/** Format a timestamp as local YYYY-MM-DD */
function localDateString(ms: number): string {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
