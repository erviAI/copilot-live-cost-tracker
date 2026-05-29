import * as vscode from 'vscode';
import type { ISpanRepository, ISessionTitleResolver } from '../data/interfaces.js';
import type { Span, DashboardData, SessionDetailData, DataSourceStatus } from '../domain/models.js';
import type { CostDataSource } from '../config.js';
import { Aggregator } from '../domain/Aggregator.js';
import { isIgnoredAgent } from '../domain/filters.js';

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

  constructor(
    private readonly spanRepo: ISpanRepository,
    private readonly titleResolver: ISessionTitleResolver,
    private readonly aggregator: Aggregator,
    private readonly getPollingInterval: () => number,
    private readonly backfillRepo: ISpanRepository | null = null,
    private readonly getCostDataSource: () => CostDataSource = () => 'agent-traces-only'
  ) {}

  /** Start the polling loop */
  start(): void {
    this.poll(); // Immediate first poll
    this.scheduleNext();
  }

  /** Force an immediate refresh */
  async refresh(): Promise<void> {
    await this.poll();
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

  /** Get detailed breakdown for a specific session (lazy-loaded on expand) */
  async getSessionDetail(sessionId: string): Promise<SessionDetailData | null> {
    try {
      const spans = await this.spanRepo.getSpansForSession(sessionId);
      if (spans.length === 0) return null;
      return this.aggregator.aggregateSessionDetail(sessionId, spans);
    } catch (err) {
      console.error('[CopilotCostTracker] getSessionDetail error:', err);
      return null;
    }
  }

  private scheduleNext(): void {
    if (this.disposed) return;
    if (this.timer) clearInterval(this.timer);
    const intervalMs = this.getPollingInterval() * 1000;
    this.timer = setInterval(() => this.poll(), intervalMs);
  }

  private async poll(): Promise<void> {
    if (this.disposed) return;

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
          console.warn('[CopilotCostTracker] Backfill error (continuing):', err);
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
        console.warn('[CopilotCostTracker] No data sources available (agent-traces.db not found, no debug logs)');
        this.lastData = this.emptyDashboard(dataSourceStatus);
        this._onDidUpdate.fire(this.lastData);
        return;
      }

      const spans = traceSpans.concat(backfillSpans);

      if (spans.length === 0) {
        console.log('[CopilotCostTracker] No spans found in last 7 days');
        this.lastData = this.emptyDashboard(dataSourceStatus);
        this._onDidUpdate.fire(this.lastData);
        return;
      }

      console.log(`[CopilotCostTracker] Polled ${traceSpans.length} trace spans + ${backfillSpans.length} debug-log spans (source: ${costDataSource})`);

      // Detect current session: most recent activity
      this.currentSessionId = this.detectCurrentSession(spans);

      // Invalidate title cache so new/renamed sessions are picked up
      this.titleResolver.invalidateCache();
      const titles = await this.titleResolver.getAllTitles();

      // Build dashboard
      this.lastData = this.aggregator.buildDashboard(spans, titles, this.currentSessionId);
      this.lastData.dataSourceStatus = dataSourceStatus;
      this._onDidUpdate.fire(this.lastData);
    } catch (err) {
      // Log but don't crash — the extension should be resilient
      console.error('[CopilotCostTracker] Poll error:', err);
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

    return latest.chatSessionId ?? latest.conversationId ?? null;
  }

  private emptyDashboard(dataSourceStatus?: DataSourceStatus): DashboardData {
    const emptyPeriod = { totalCost: 0, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, byModel: [] };
    return {
      today: emptyPeriod,
      thisWeek: emptyPeriod,
      currentSession: { ...emptyPeriod, sessionId: null, title: null, agentName: null, latestSpanTimeMs: null, spanCount: 0 },
      last7Days: [],
      recentSessions: [],
      updatedAt: new Date().toISOString(),
      dataSourceStatus,
    };
  }

  private getUnavailableGuidance(): string {
    return `Cost tracking requires agent-traces.db which is created by VS Code Copilot Chat.\n\nIf the file doesn't exist:\n1. Use Copilot Chat at least once\n2. Restart VS Code\n\nExpected path: %APPDATA%/Code/User/globalStorage/github.copilot-chat/agent-traces.db`;
  }

  /** Update polling interval when settings change */
  onConfigurationChanged(): void {
    this.scheduleNext();
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
