import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  CurrentDayData,
  DailyAggregate,
  SessionSnapshot,
} from '../domain/models.js';
import {
  aggregateSnapshots,
  mergeDailyAggregates,
  localDateString,
} from '../domain/dailyAggregation.js';
import { logger } from '../logger.js';

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
   * Persist a set of per-day aggregates into history files.
   *
   * Today's aggregate is written to `current.json`; past days are max-merged into
   * their `daily/YYYY-MM-DD.json` files so previously-recorded totals never
   * decrease (protecting against the source DB being partially cleaned).
   *
   * Called periodically by CostTrackingService and on startup for backfill.
   */
  async persist(days: Map<string, DailyAggregate>): Promise<void> {
    try {
      await this.ensureDirectories();

      const today = localDateString(Date.now());

      // Roll over a stale current.json (e.g. extension ran past midnight).
      const existing = await this.readCurrentDay();
      if (existing && existing.date !== today) {
        await this.rollup(existing);
      }

      for (const [date, agg] of days) {
        if (date === today) {
          // Merge with any existing same-day current.json so a partially-cleaned
          // DB read can only add sessions / raise costs, never drop them.
          const existingToday =
            existing && existing.date === today
              ? aggregateSnapshots(today, existing.sessions)
              : null;
          const merged = mergeDailyAggregates(existingToday, agg);
          const currentDay: CurrentDayData = {
            date: today,
            lastUpdatedAt: new Date().toISOString(),
            sessions: merged.sessions ?? [],
          };
          await this.atomicWrite(this.currentPath, currentDay);
        } else {
          const dailyPath = path.join(this.dailyDir, `${date}.json`);
          const prior = await this.readDaily(date);
          const merged = mergeDailyAggregates(prior, agg);
          await this.atomicWrite(dailyPath, merged);
        }
      }
    } catch (err) {
      logger.error('History persist error:', err);
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
          logger.info(`Pruned history file: ${entry}`);
        }
      }
    } catch (err) {
      logger.error('History prune error:', err);
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

  /**
   * Find a persisted per-session snapshot by id, searching today's current.json
   * first and then daily files newest-first. Returns null when not found.
   * Used to reconstruct a session's per-model breakdown after its live spans are
   * purged from agent-traces.db.
   */
  async getSessionSnapshot(sessionId: string): Promise<SessionSnapshot | null> {
    const current = await this.readCurrentDay();
    const fromCurrent = current?.sessions.find(s => s.sessionId === sessionId);
    if (fromCurrent) return fromCurrent;

    let entries: string[];
    try {
      entries = await fs.readdir(this.dailyDir);
    } catch {
      return null;
    }

    const dailyFiles = entries.filter(e => e.endsWith('.json')).sort().reverse();
    for (const entry of dailyFiles) {
      const date = entry.replace('.json', '');
      const agg = await this.readDaily(date);
      const found = agg?.sessions?.find(s => s.sessionId === sessionId);
      if (found) return found;
    }
    return null;
  }

  // --- Private Helpers ---

  /** Roll a stale current.json day into its daily file (max-merged). */
  private async rollup(currentDay: CurrentDayData): Promise<void> {
    const { date, sessions } = currentDay;

    const aggregate = aggregateSnapshots(date, sessions);
    const prior = await this.readDaily(date);
    const merged = mergeDailyAggregates(prior, aggregate);

    const dailyPath = path.join(this.dailyDir, `${date}.json`);
    await this.atomicWrite(dailyPath, merged);

    // Reset current.json for the new day
    const fresh: CurrentDayData = {
      date: localDateString(Date.now()),
      lastUpdatedAt: new Date().toISOString(),
      sessions: [],
    };
    await this.atomicWrite(this.currentPath, fresh);

    logger.info(`Rolled up ${sessions.length} sessions for ${date}`);
  }

  private async readCurrentDay(): Promise<CurrentDayData | null> {
    try {
      const content = await fs.readFile(this.currentPath, 'utf-8');
      return JSON.parse(content) as CurrentDayData;
    } catch {
      return null;
    }
  }

  private async readDaily(date: string): Promise<DailyAggregate | null> {
    try {
      const content = await fs.readFile(path.join(this.dailyDir, `${date}.json`), 'utf-8');
      return JSON.parse(content) as DailyAggregate;
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
