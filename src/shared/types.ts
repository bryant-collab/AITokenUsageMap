export type TokenUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  /** Portion of cachedInputTokens written to a 5-minute cache. Only set when a source reports cache writes. */
  cacheWrite5mTokens?: number;
  /** Portion of cachedInputTokens written to a 1-hour cache. Only set when a source reports cache writes. */
  cacheWrite1hTokens?: number;
};

export type HarnessId = "codex" | "github-copilot" | "claude-code";

export type ModelPricingSource = "catalog" | "manual" | "missing";

export type ModelPricingProvider = "openai" | "anthropic" | "unknown";

export type ModelPricing = {
  model: string;
  normalizedModel: string;
  provider: ModelPricingProvider;
  source: ModelPricingSource;
  inputUsdPerMillion: number | null;
  cachedInputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  sourceUrl: string | null;
  notes: string[];
  updatedAt: string | null;
  cachedAt: string;
};

export type PricingResponse = {
  rates: ModelPricing[];
};

export type ModelPricingUpdate = {
  model: string;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number | null;
  outputUsdPerMillion: number;
};

export type HarnessConfidence = {
  captured: string;
  total: string;
  billing: string;
};

export type HarnessInfo = {
  id: HarnessId;
  name: string;
  description: string;
  usageLabel: string;
  confidence: HarnessConfidence | null;
  caveats: string[];
};

export type DayTotal = TokenUsage & {
  date: string;
  events: number;
  sessions: number;
};

export type WeeklyTotal = TokenUsage & {
  weekStart: string;
  events: number;
};

export type SessionDayTotal = TokenUsage & {
  sessionId: string;
  cwd: string | null;
  source: string | null;
  originator: string | null;
  cliVersion: string | null;
  model: string;
  events: number;
  firstSeen: string;
  lastSeen: string;
  /** Usage inferred from a session-level total rather than from logged requests. */
  estimated?: boolean;
};

export type RateLimitSnapshot = {
  timestamp: string;
  limitId: string | null;
  planType: string | null;
  primary: {
    usedPercent: number | null;
    windowMinutes: number | null;
    resetsAt: number | null;
  } | null;
  secondary: {
    usedPercent: number | null;
    windowMinutes: number | null;
    resetsAt: number | null;
  } | null;
};

export type Diagnostics = {
  filesScanned: number;
  filesFromCache: number;
  filesParsed: number;
  skippedFiles: number;
  parseErrors: number;
  tokenEvents: number;
  lastScanStartedAt: string | null;
  lastScanCompletedAt: string | null;
};

export type SummaryResponse = {
  harness: HarnessInfo;
  range: {
    from: string;
    to: string;
    timezone: string;
  };
  totals: TokenUsage;
  today: DayTotal | null;
  lastHour: TokenUsage;
  lastSevenDays: TokenUsage;
  peakDay: DayTotal | null;
  daily: DayTotal[];
  weekly: WeeklyTotal[];
  latestRateLimit: RateLimitSnapshot | null;
  diagnostics: Diagnostics;
};

export type DayResponse = {
  harness: HarnessInfo;
  date: string;
  totals: DayTotal | null;
  sessions: SessionDayTotal[];
  rateLimit: {
    latestForDay: RateLimitSnapshot | null;
    weekToDate: TokenUsage & {
      weekStart: string;
      through: string;
      events: number;
    };
  };
};

export type ModelUsageRangeRow = TokenUsage & {
  harness: HarnessInfo;
  date: string;
  model: string;
  events: number;
  sessions: number;
  /** Usage inferred from a session-level total rather than from logged requests. */
  estimated?: boolean;
};

export type ModelUsageRangeResponse = {
  range: {
    from: string;
    to: string;
    timezone: string;
  };
  rows: ModelUsageRangeRow[];
};

export type DashboardResponse = {
  range: {
    from: string;
    to: string;
    timezone: string;
  };
  harnesses: SummaryResponse[];
};

export type ConfigResponse = {
  timezone: string;
  codexRoots: string[];
  copilotRoots: string[];
  claudeRoots: string[];
  cachePath: string;
  cacheExists: boolean;
  diagnostics: Record<HarnessId, Diagnostics>;
};
