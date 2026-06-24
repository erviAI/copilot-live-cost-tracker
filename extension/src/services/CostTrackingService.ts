import * as vscode from 'vscode';
import type { ISpanRepository, ISessionTitleResolver, ITurnLabelProvider, IToolCallProvider } from '../data/interfaces.js';
import type { Span, DashboardData, SessionDetailData, DataSourceStatus, PeriodCost, RangePreset, RangeSummary, RecentPrompt, DailyAggregate, ModelDetailBreakdown } from '../domain/models.js';
import type { CostDataSource } from '../config.js';
import type { CostHistoryService } from './CostHistoryService.js';
import { Aggregator } from '../domain/Aggregator.js';
import { buildRangeSummary, periodCostToDailyAggregate, RANGE_PRESETS } from '../domain/rangeSummary.js';
import { bucketSessionsByDay, sessionsToDailyAggregate } from '../domain/dailyAggregation.js';
import { isIgnoredAgent } from '../domain/filters.js';
import { isSubagentSessionId } from '../domain/sessionIds.js';
import { logger } from '../logger.js';

/**
 * CostTrackingService orchestrates periodic polling of the database
 * and emits dashboard data updates to subscribers.
 *
 * Single Responsibility: polling lifecycle + data refresh coordination.
 */
export class CostTrackingService implements vscode.Disposable {
  private readonly _onDidUpdate = new vscode.EventEmitter<DashboardData>();
  readonly onDidUpdate = this._onDidUpdate.event;

  private timer: ReturnType<typeof setInterval> | null = null;
  private lastData: DashboardData | null = null;
  private currentSessionId: string | null = null;
  private disposed = false;
  private polling = false;
  private pollCount = 0;
  private historyService: CostHistoryService | null = null;
  private historyScrapeInterval = 30;
  private getHistoryRetentionDays: () => number = () => 90;

  constructor(
    private readonly spanRepo: ISpanRepository,
    private readonly titleResolver: ISessionTitleResolver,
    private readonly aggregator: Aggregator,
    private readonly getPollingInterval: () => number,
    private readonly backfillRepo: ISpanRepository | null = null,
    private readonly getCostDataSource: () => CostDataSource = () => 'agent-traces-only',
    private readonly turnLabelProvider: ITurnLabelProvider | null = null,
    private readonly toolCallProvider: IToolCallProvider | null = null
  ) {}

  /** Attach a history service for periodic persistence */
  setHistoryService(service: CostHistoryService, scrapeInterval: number, getRetentionDays?: () => number): void {
    this.historyService = service;
    this.historyScrapeInterval = scrapeInterval;
    if (getRetentionDays) this.getHistoryRetentionDays = getRetentionDays;
  }

  /** Update how often (in poll cycles) data is scraped to history. */
  setScrapeInterval(scrapeInterval: number): void {
    this.historyScrapeInterval = scrapeInterval;
  }

  /** Start the polling loop */
  start(): void {
    this.poll(); // Immediate first poll
    this.scheduleNext();
  }

  /** Force an immediate refresh */
  async refresh(): Promise<void> {
    await this.poll();
  }

  /**
   * Backfill persisted history from the full agent-traces.db window available on
   * disk. Run on startup so days still present in the DB (e.g. while the
   * extension was inactive) are durably persisted before the DB is next cleaned.
   */
  async backfillFromDb(): Promise<void> {
    if (!this.historyService) return;
    try {
      if (!(await this.spanRepo.isAvailable())) return;
      const days = this.getHistoryRetentionDays();
      const since = Date.now() - days * 24 * 60 * 60 * 1000;
      const spans = await this.spanRepo.getSpansSince(since);
      if (spans.length === 0) return;

      this.titleResolver.invalidateCache();
      const titles = await this.titleResolver.getAllTitles();
      const workspaces = await this.titleResolver.getAllWorkspaces();
      const dayAggregates = this.buildDayAggregates(spans, titles, workspaces);
      await this.historyService.persist(dayAggregates);
      logger.info(`Backfilled history for ${dayAggregates.size} day(s) from agent-traces.db`);
    } catch (err) {
      logger.warn('History backfill failed (continuing):', err);
    }
  }

  /**
   * Group spans into per-day aggregates (with retained per-session snapshots),
   * bucketed by each session's local start day. Used by both periodic scraping
   * and startup backfill.
   */
  private buildDayAggregates(
    spans: Span[],
    titles: Map<string, string>,
    workspaces: Map<string, string | null>
  ): Map<string, DailyAggregate> {
    const sessions = this.aggregator.buildSessions(spans, titles, workspaces);
    const byDay = bucketSessionsByDay(sessions);
    const result = new Map<string, DailyAggregate>();
    for (const [date, daySessions] of byDay) {
      result.set(date, sessionsToDailyAggregate(date, daySessions));
    }
    return result;
  }

  /** Get the latest dashboard data (cached) */
  getLastData(): DashboardData | null {
    return this.lastData;
  }

  /** Get the current active session ID */
  getCurrentSessionId(): string | null {
    return this.currentSessionId;
  }

  /** Manually set/reset the tracked session */
  resetSession(): void {
    this.currentSessionId = null;
  }

  /**
   * Build a cost summary for a preset date range (7d/30d/90d), combining
   * persisted daily history with today's live snapshot.
   */
  async getRangeSummary(preset: RangePreset): Promise<RangeSummary> {
    const now = new Date();
    const days = RANGE_PRESETS[preset];

    let history: Awaited<ReturnType<CostHistoryService['getHistory']>> = [];
    if (this.historyService) {
      try {
        history = await this.historyService.getHistory(days);
      } catch (err) {
        logger.warn('getRangeSummary history read failed (continuing with live data):', err);
      }
    }

    const today = this.lastData
      ? periodCostToDailyAggregate(this.lastData.today, toLocalDate(now))
      : null;

    return buildRangeSummary(preset, history, today, now);
  }

  /** Get detailed breakdown for a specific session (lazy-loaded on expand) */
  async getSessionDetail(sessionId: string): Promise<SessionDetailData | null> {
    let spans: Span[] = [];
    try {
      spans = await this.spanRepo.getSpansForSession(sessionId);
    } catch (err) {
      logger.warn('getSessionDetail span fetch failed (trying history fallback):', err);
    }
    // Live spans are gone (DB cleaned) — reconstruct a per-model-only view from
    // persisted history so the modal can still show something useful.
    if (spans.length === 0) {
      return this.historicSessionDetail(sessionId);
    }
    try {
      // Fetch turn labels from agent-traces.db (keyed by traceId) when a provider is available.
      let turnLabels: Map<string, string> | undefined;
      if (this.turnLabelProvider) {
        try { turnLabels = await this.turnLabelProvider.getTurnLabels(sessionId); } catch { /* ignore */ }
      }
      let toolSpans: Span[] | undefined;
      if (this.toolCallProvider) {
        try { toolSpans = await this.toolCallProvider.getToolSpansForSession(sessionId); } catch { /* ignore */ }
      }
      return this.aggregator.aggregateSessionDetail(sessionId, spans, turnLabels, toolSpans);
    } catch (err) {
      logger.error('getSessionDetail error:', err);
      return null;
    }
  }

  /**
   * Reconstruct a session's per-model breakdown from persisted history when its
   * live per-turn spans are no longer in agent-traces.db. Returns null when no
   * snapshot exists. The result has no per-turn detail (`turns` is empty) and is
   * flagged `historic` so the UI can explain the missing detail.
   */
  private async historicSessionDetail(sessionId: string): Promise<SessionDetailData | null> {
    if (!this.historyService) return null;
    try {
      const snap = await this.historyService.getSessionSnapshot(sessionId);
      if (!snap) return null;
      const byModel: ModelDetailBreakdown[] = snap.byModel.map(m => ({
        model: m.model,
        calls: m.calls,
        inputTokens: m.inputTokens,
        outputTokens: m.outputTokens,
        cachedTokens: m.cachedTokens,
        cacheWriteTokens: m.cacheWriteTokens,
        freshInputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        outputCost: 0,
        totalCost: m.totalCost,
        avgDurationMs: 0,
        rateTokensPerSec: 0,
        cacheHitPct: m.inputTokens > 0 ? Math.round((100 * m.cachedTokens) / m.inputTokens) : 0,
      }));
      return {
        sessionId,
        turns: [],
        byModel,
        totalCost: snap.totalCost,
        totalLlmCalls: snap.byModel.reduce((sum, m) => sum + m.calls, 0),
        historic: true,
      };
    } catch (err) {
      logger.warn('historicSessionDetail failed:', err);
      return null;
    }
  }

  /**
   * Flatten the per-prompt (turn) costs from the most recent sessions into a
   * single newest-first list, for the dashboard Activity table.
   * @param maxSessions How many recent sessions to pull turns from.
   * @param maxPrompts Cap on the total number of prompts returned.
   */
  async getRecentTurns(maxSessions = 5, maxPrompts = 50): Promise<RecentPrompt[]> {
    const sessions = this.lastData?.recentSessions ?? [];
    const prompts: RecentPrompt[] = [];
    for (const session of sessions.slice(0, maxSessions)) {
      try {
        const detail = await this.getSessionDetail(session.sessionId);
        if (!detail) continue;
        for (const turn of detail.turns) {
          prompts.push({ ...turn, sessionId: session.sessionId, sessionTitle: session.title });
        }
      } catch (err) {
        logger.warn('getRecentTurns: session detail failed (continuing):', err);
      }
    }
    prompts.sort((a, b) => b.startTimeMs - a.startTimeMs);
    return prompts.slice(0, maxPrompts);
  }

  private scheduleNext(): void {
    if (this.disposed) return;
    if (this.timer) clearInterval(this.timer);
    const intervalMs = this.getPollingInterval() * 1000;
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  private async poll(): Promise<void> {
    if (this.disposed) return;
    if (this.polling) return; // Skip if a previous poll is still in flight
    this.polling = true;

    try {
      // Get spans for the past 7 days (enough for all dashboard sections)
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const costDataSource = this.getCostDataSource();

      // Primary source: agent-traces.db (may not exist on older Copilot versions)
      let traceSpans: Span[] = [];
      const tracesAvailable = await this.spanRepo.isAvailable();
      if (tracesAvailable) {
        traceSpans = await this.spanRepo.getSpansSince(sevenDaysAgo);
      }

      // Fallback/backfill: debug-logs (main.jsonl files) — only if enabled
      let backfillSpans: Span[] = [];
      const useBackfill = costDataSource === 'with-fallback';
      if (useBackfill && this.backfillRepo) {
        try {
          if (await this.backfillRepo.isAvailable()) {
            const raw = await this.backfillRepo.getSpansSince(sevenDaysAgo);
            backfillSpans = tracesAvailable
              ? filterDaysCoveredByTraces(raw, traceSpans)
              : raw;
          }
        } catch (err) {
          logger.warn('Backfill error (continuing):', err);
        }
      }

      // Determine data source status
      let dataSourceStatus: DataSourceStatus;
      if (tracesAvailable && traceSpans.length > 0) {
        dataSourceStatus = { source: 'agent-traces', agentTracesAvailable: true };
      } else if (backfillSpans.length > 0) {
        dataSourceStatus = {
          source: 'debug-logs',
          agentTracesAvailable: false,
          message: 'Using debug-logs fallback. Cache write data will be missing. Enable agent-traces.db for accurate cost tracking.',
        };
      } else {
        dataSourceStatus = {
          source: 'none',
          agentTracesAvailable: false,
          message: this.getUnavailableGuidance(),
        };
      }

      if (!tracesAvailable && backfillSpans.length === 0) {
        logger.warn('No data sources available (agent-traces.db not found, no debug logs)');
        this.lastData = this.emptyDashboard(dataSourceStatus);
        this._onDidUpdate.fire(this.lastData);
        return;
      }

      const spans = traceSpans.concat(backfillSpans);

      if (spans.length === 0) {
        logger.info('No spans found in last 7 days');
        this.lastData = this.emptyDashboard(dataSourceStatus);
        this._onDidUpdate.fire(this.lastData);
        return;
      }

      logger.info(`Polled ${traceSpans.length} trace spans + ${backfillSpans.length} debug-log spans (source: ${costDataSource})`);

      // Detect current session: most recent activity
      this.currentSessionId = this.detectCurrentSession(spans);

      // Invalidate title cache so new/renamed sessions are picked up
      this.titleResolver.invalidateCache();
      const titles = await this.titleResolver.getAllTitles();

      // Fetch workspace names for sessions (populated during title scan)
      const sessionWorkspaces = await this.titleResolver.getAllWorkspaces();

      // Build dashboard
      this.lastData = this.aggregator.buildDashboard(spans, titles, this.currentSessionId, sessionWorkspaces);
      this.lastData.dataSourceStatus = dataSourceStatus;
      this._onDidUpdate.fire(this.lastData);

      // Periodically scrape to history files
      this.pollCount++;
      if (this.historyService && this.pollCount % this.historyScrapeInterval === 0) {
        const dayAggregates = this.buildDayAggregates(spans, titles, sessionWorkspaces);
        void this.historyService.persist(dayAggregates);
      }
    } catch (err) {
      // Log but don't crash — the extension should be resilient
      logger.error('Poll error:', err);
      // If we have never produced data, surface the failure in the UI instead of
      // leaving it stuck on the initial "Loading…" / "Waiting for data" state.
      // (When we already have good data, keep showing it through transient errors.)
      if (!this.lastData) {
        const dataSourceStatus: DataSourceStatus = {
          source: 'none',
          agentTracesAvailable: false,
          message: this.describePollError(err),
        };
        this.lastData = this.emptyDashboard(dataSourceStatus);
        this._onDidUpdate.fire(this.lastData);
      }
    } finally {
      this.polling = false;
    }
  }

  /**
   * Detect the current active session.
   * Heuristic: the session with the most recent span activity.
   */
  private detectCurrentSession(spans: Span[]): string | null {
    if (spans.length === 0) return null;

    // Exclude internal/utility agents (e.g. copilotLanguageModelWrapper) that
    // are not user-facing chat sessions.
    const candidates = spans.filter(s => !isIgnoredAgent(s));
    if (candidates.length === 0) return null;

    // Find the most recent span
    let latest = candidates[0];
    for (const span of candidates) {
      if (span.startTimeMs > latest.startTimeMs) {
        latest = span;
      }
    }

    // Only consider it "current" if activity was in the last hour
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    if (latest.startTimeMs < oneHourAgo) return null;

    // Subagent spans have chatSessionId set to a tool-call ID (e.g. "toolu_..." or "call_...").
    // Resolve to the real parent session via trace_id correlation.
    if (isSubagentSessionId(latest.chatSessionId)) {
      // Find another span in the same trace with a real session ID
      const parentSpan = candidates.find(
        s => s.traceId === latest.traceId && s.chatSessionId && !isSubagentSessionId(s.chatSessionId)
      );
      if (parentSpan) return parentSpan.chatSessionId;
    }
    return latest.chatSessionId ?? latest.conversationId ?? null;
  }

  private emptyDashboard(dataSourceStatus?: DataSourceStatus): DashboardData {
    const emptyPeriod: PeriodCost = { totalCost: 0, modelTurns: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, byModel: [], byWorkspace: [] };
    return {
      today: emptyPeriod,
      thisWeek: emptyPeriod,
      currentSession: { ...emptyPeriod, sessionId: null, title: null, agentName: null, workspace: null, latestSpanTimeMs: null, spanCount: 0, contextWeightTokens: 0 },
      last7Days: [],
      recentSessions: [],
      updatedAt: new Date().toISOString(),
      dataSourceStatus,
    };
  }

  private getUnavailableGuidance(): string {
    return `Cost tracking reads agent-traces.db, which Copilot Chat only writes when OpenTelemetry tracing is enabled.\n\nTo fix this:\n1. Enable the setting "github.copilot.chat.otel.dbSpanExporter.enabled"\n2. Run a Copilot Chat session\n3. Restart VS Code if the file still isn't created\n\nExpected location: <VS Code user data>/User/globalStorage/github.copilot-chat/agent-traces.db`;
  }

  /**
   * Build a human-readable, actionable message for a failed poll. Native
   * (better-sqlite3) ABI mismatches are the most common cause and have a
   * specific fix, so we detect and explain them directly.
   */
  private describePollError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    if (/NODE_MODULE_VERSION|compiled against a different Node\.js version|was compiled against/i.test(msg)) {
      return `The native SQLite module (better-sqlite3) is built for a different Node.js version than the one on your PATH.\n\nTo fix this:\n1. Run "npm rebuild better-sqlite3" in the extension folder\n2. Reload the window (Developer: Reload Window)\n\nDetails: ${msg}`;
    }
    return `Failed to read cost data from agent-traces.db.\n\nDetails: ${msg}`;
  }

  /** Update polling interval when settings change */
  onConfigurationChanged(): void {
    this.scheduleNext();
  }

  /** Flush history to disk (call on deactivation) */
  async flushHistory(): Promise<void> {
    if (this.historyService) {
      await this.backfillFromDb();
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._onDidUpdate.dispose();
  }
}

/**
 * Drop any backfill spans whose local day already has coverage in `traceSpans`.
 * Trace data is preferred per-day because it includes cache-write tokens that
 * debug logs don't carry.
 */
function filterDaysCoveredByTraces(backfill: Span[], traceSpans: Span[]): Span[] {
  if (backfill.length === 0) return backfill;
  const coveredDays = new Set<string>();
  for (const s of traceSpans) {
    coveredDays.add(localDayKey(s.startTimeMs));
  }
  return backfill.filter(s => !coveredDays.has(localDayKey(s.startTimeMs)));
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Local-time YYYY-MM-DD string (matches rangeSummary + history date format). */
function toLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
