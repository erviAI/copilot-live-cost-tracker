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
  /** True when costs were derived from estimated (family-inferred) pricing. */
  estimated?: boolean;
  /** True when no pricing could be resolved at all — cost is reported as $0 but is unknown. */
  unpriced?: boolean;
}

/** Aggregated cost data for a time period */
export interface PeriodCost {
  totalCost: number;
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  byModel: ModelCost[];
  byWorkspace: WorkspaceCost[];
}

/** Session summary for the recent sessions list */
export interface SessionInfo {
  sessionId: string;
  title: string;
  model: string | null;
  agentName: string | null;
  workspace: string | null;
  startedAt: number;
  endedAt: number;
  totalCost: number;
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  byModel: ModelCost[];
}

/** Daily bucket for the 7-day chart */
export interface DailyBucket {
  date: string; // YYYY-MM-DD
  dayLabel: string; // e.g. "Mon", "Tue"
  totalCost: number;
  modelTurns: number;
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
    workspace: string | null;
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
  spanId: string;
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
  /**
   * True when these rates were inferred from a related model family rather than
   * matched exactly (e.g. a newly launched version not yet in the pricing table).
   * Costs derived from estimated pricing should be surfaced as tentative.
   */
  estimated?: boolean;
}

// --- Cost History Persistence Types ---

/** Per-model subset stored in history files */
export interface ModelCostSnapshot {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  totalCost: number;
}

/** Per-workspace breakdown in daily aggregate */
export interface WorkspaceCost {
  workspace: string;
  totalCost: number;
  modelTurns: number;
  sessionCount: number;
}

/** Per-session snapshot stored in current.json (today's sessions) */
export interface SessionSnapshot {
  sessionId: string;
  title: string | null;
  workspace: string | null;
  totalCost: number;
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  byModel: ModelCostSnapshot[];
  startedAt: number;
  endedAt: number;
}

/** The current day's data (current.json) */
export interface CurrentDayData {
  date: string; // YYYY-MM-DD
  lastUpdatedAt: string; // ISO timestamp
  sessions: SessionSnapshot[];
}

/** Rolled-up daily aggregate (daily/YYYY-MM-DD.json) */
export interface DailyAggregate {
  date: string; // YYYY-MM-DD
  totalCost: number;
  modelTurns: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  byModel: ModelCostSnapshot[];
  byWorkspace: WorkspaceCost[];
  sessionCount: number;
}
