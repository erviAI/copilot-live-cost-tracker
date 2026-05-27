import * as vscode from 'vscode';
import type { ISpanRepository, ISessionTitleResolver } from '../data/interfaces.js';
import type { Span, DashboardData, SessionDetailData } from '../domain/models.js';
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
    private readonly backfillRepo: ISpanRepository | null = null
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
      const available = await this.spanRepo.isAvailable();
      if (!available) {
        console.warn('[CopilotCostTracker] Database not available');
        return;
      }

      // Get spans for the past 7 days (enough for all dashboard sections)
      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const traceSpans = await this.spanRepo.getSpansSince(sevenDaysAgo);

      // Backfill older days from main.jsonl debug logs where the trace DB
      // has no chat spans (OTel tracing is newer than the debug log).
      let backfillSpans: Span[] = [];
      if (this.backfillRepo) {
        try {
          if (await this.backfillRepo.isAvailable()) {
            const raw = await this.backfillRepo.getSpansSince(sevenDaysAgo);
            backfillSpans = filterDaysCoveredByTraces(raw, traceSpans);
          }
        } catch (err) {
          console.warn('[CopilotCostTracker] Backfill error (continuing):', err);
        }
      }

      const spans = traceSpans.concat(backfillSpans);

      if (spans.length === 0) {
        console.log('[CopilotCostTracker] No spans found in last 7 days');
        this.lastData = this.emptyDashboard();
        this._onDidUpdate.fire(this.lastData);
        return;
      }

      console.log(`[CopilotCostTracker] Polled ${traceSpans.length} trace spans + ${backfillSpans.length} debug-log spans`);

      // Detect current session: most recent activity
      this.currentSessionId = this.detectCurrentSession(spans);

      // Invalidate title cache so new/renamed sessions are picked up
      this.titleResolver.invalidateCache();
      const titles = await this.titleResolver.getAllTitles();

      // Build dashboard
      this.lastData = this.aggregator.buildDashboard(spans, titles, this.currentSessionId);
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

  private emptyDashboard(): DashboardData {
    const emptyPeriod = { totalCost: 0, requests: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, byModel: [] };
    return {
      today: emptyPeriod,
      thisWeek: emptyPeriod,
      currentSession: { ...emptyPeriod, sessionId: null, title: null, agentName: null, latestSpanTimeMs: null, spanCount: 0 },
      last7Days: [],
      recentSessions: [],
      updatedAt: new Date().toISOString(),
    };
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
