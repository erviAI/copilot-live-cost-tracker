import * as vscode from 'vscode';
import type { ISpanRepository, ISessionTitleResolver } from '../data/interfaces.js';
import type { Span, DashboardData } from '../domain/models.js';
import { Aggregator } from '../domain/Aggregator.js';

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
    private readonly getPollingInterval: () => number
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
      const spans = await this.spanRepo.getSpansSince(sevenDaysAgo);

      if (spans.length === 0) {
        console.log('[CopilotCostTracker] No spans found in last 7 days');
        this.lastData = this.emptyDashboard();
        this._onDidUpdate.fire(this.lastData);
        return;
      }

      console.log(`[CopilotCostTracker] Polled ${spans.length} spans`);

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

    // Find the most recent span
    let latest = spans[0];
    for (const span of spans) {
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
      currentSession: { ...emptyPeriod, sessionId: null },
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
