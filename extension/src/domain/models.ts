/**
 * Domain models for the Copilot Cost Tracker.
 * All types are plain data structures — no behavior.
 */

/** Raw span data from agent-traces.db */
export interface Span {
  spanId: string;
  traceId: string;
  parentSpanId: string | null;
  operationName: string;
  agentName: string | null;
  requestModel: string | null;
  responseModel: string | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  startTimeMs: number;
  endTimeMs: number;
  ttftMs: number | null;
  chatSessionId: string | null;
  conversationId: string | null;
  turnIndex: number | null;
  statusCode: number;
  statusMessage: string | null;
  toolName: string | null;
}

/** Per-model token and cost aggregate */
export interface ModelCost {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  freshInputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  outputCost: number;
  totalCost: number;
}

/** Aggregated cost data for a time period */
export interface PeriodCost {
  totalCost: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  byModel: ModelCost[];
}

/** Session summary for the recent sessions list */
export interface SessionInfo {
  sessionId: string;
  title: string;
  model: string | null;
  agentName: string | null;
  startedAt: number;
  endedAt: number;
  totalCost: number;
  requests: number;
}

/** Daily bucket for the 7-day chart */
export interface DailyBucket {
  date: string; // YYYY-MM-DD
  dayLabel: string; // e.g. "Mon", "Tue"
  totalCost: number;
  requests: number;
}

/** Status of the cost data source */
export interface DataSourceStatus {
  source: 'agent-traces' | 'debug-logs' | 'none';
  agentTracesAvailable: boolean;
  message?: string;
}

/** Complete dashboard state sent to the webview */
export interface DashboardData {
  today: PeriodCost;
  thisWeek: PeriodCost;
  currentSession: PeriodCost & {
    sessionId: string | null;
    title: string | null;
    agentName: string | null;
    latestSpanTimeMs: number | null;
    spanCount: number;
  };
  last7Days: DailyBucket[];
  recentSessions: SessionInfo[];
  updatedAt: string; // ISO timestamp
  dataSourceStatus?: DataSourceStatus;
}

/** Budget threshold configuration */
export interface BudgetThresholds {
  session: { warning: number; limit: number };
  daily: { warning: number; limit: number };
  weekly: { warning: number; limit: number };
}

/** Budget alert state */
export interface BudgetState {
  sessionLevel: 'ok' | 'warning' | 'limit';
  dailyLevel: 'ok' | 'warning' | 'limit';
  weeklyLevel: 'ok' | 'warning' | 'limit';
}

/** Individual span detail within a turn */
export interface SpanDetail {
  traceId: string;
  agentName: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  durationMs: number;
}

/** Per-turn cost breakdown for session detail view */
export interface TurnCost {
  turnIndex: number;
  traceId: string;
  label: string | null;
  agentName: string | null;
  model: string | null;
  startTimeMs: number;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
  durationMs: number;
  spans: SpanDetail[];
  /** Subagent calls nested within this turn */
  children?: TurnCost[];
}

/** Per-model breakdown with rate and cache hit stats */
export interface ModelDetailBreakdown extends ModelCost {
  avgDurationMs: number;
  rateTokensPerSec: number;
  cacheHitPct: number;
}

/** Full session detail data returned on expand */
export interface SessionDetailData {
  sessionId: string;
  turns: TurnCost[];
  byModel: ModelDetailBreakdown[];
  totalCost: number;
  totalLlmCalls: number;
}

/** Pricing rates for a model (all per 1M tokens) */
export interface ModelPricing {
  input: number;
  output: number;
  cached: number;
  cacheWrite?: number;
}
