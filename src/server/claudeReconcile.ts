import type { SessionDayTotal, TokenUsage } from "../shared/types";
import type { ParsedFileSummary } from "./parser";

type UsageParts = {
  input: number;
  cacheRead: number;
  write5m: number;
  write1h: number;
  output: number;
};

const PART_NAMES = ["input", "cacheRead", "write5m", "write1h", "output"] as const;

const partsFrom = (usage: TokenUsage): UsageParts => {
  const write5m = usage.cacheWrite5mTokens ?? 0;
  const write1h = usage.cacheWrite1hTokens ?? 0;
  return {
    input: usage.inputTokens,
    cacheRead: Math.max(0, usage.cachedInputTokens - write5m - write1h),
    write5m,
    write1h,
    output: usage.outputTokens
  };
};

const addParts = (byModel: Map<string, UsageParts>, model: string, usage: TokenUsage): void => {
  // Model keys can carry a context suffix such as "[1m]" that request records omit.
  const key = model.replace(/\[[^\]]*\]$/, "");
  const parts = partsFrom(usage);
  const existing = byModel.get(key);
  if (!existing) {
    byModel.set(key, parts);
    return;
  }
  for (const name of PART_NAMES) existing[name] += parts[name];
};

const partsTotal = (parts: UsageParts): number => PART_NAMES.reduce((sum, name) => sum + parts[name], 0);

const sumTotals = (byModel: Map<string, UsageParts>): number => (
  [...byModel.values()].reduce((sum, parts) => sum + partsTotal(parts), 0)
);

const usageFromParts = (parts: UsageParts): TokenUsage => ({
  inputTokens: parts.input,
  cachedInputTokens: parts.cacheRead + parts.write5m + parts.write1h,
  outputTokens: parts.output,
  reasoningOutputTokens: 0,
  totalTokens: partsTotal(parts),
  ...(parts.write5m > 0 && { cacheWrite5mTokens: parts.write5m }),
  ...(parts.write1h > 0 && { cacheWrite1hTokens: parts.write1h })
});

const estimateSession = (transcripts: ParsedFileSummary[]): ParsedFileSummary | null => {
  const withCostState = transcripts.find((summary) => summary.claudeCostState);
  if (!withCostState?.claudeCostState) return null;
  // A fork inherits its parent's totals but only some of its requests, so the difference is unreliable.
  if (transcripts.some((summary) => summary.claudeForked)) return null;

  const counted = new Map<string, UsageParts>();
  let latest: { date: string; row: SessionDayTotal } | null = null;
  for (const summary of transcripts) {
    for (const [date, rows] of Object.entries(summary.daily)) {
      for (const row of rows) {
        addParts(counted, row.model, row);
        if (!latest || row.lastSeen > latest.row.lastSeen) latest = { date, row };
      }
    }
  }
  if (!latest) return null;

  const reported = new Map<string, UsageParts>();
  for (const [model, usage] of Object.entries(withCostState.claudeCostState.modelUsage)) {
    addParts(reported, model, usage);
  }

  // Resumed sessions can log requests past their last cost-state record until they exit again.
  const sessionGap = sumTotals(reported) - sumTotals(counted);
  if (sessionGap <= 0) return null;

  const estimates: SessionDayTotal[] = [];
  let estimatedTotal = 0;
  for (const [model, parts] of reported) {
    const seen = counted.get(model);
    const gap = {} as UsageParts;
    for (const name of PART_NAMES) gap[name] = Math.max(0, parts[name] - (seen?.[name] ?? 0));
    const usage = usageFromParts(gap);
    if (usage.totalTokens <= 0) continue;
    estimatedTotal += usage.totalTokens;
    estimates.push({
      ...usage,
      sessionId: latest.row.sessionId,
      cwd: latest.row.cwd,
      source: withCostState.path,
      originator: latest.row.originator,
      cliVersion: latest.row.cliVersion,
      model,
      events: 0,
      firstSeen: latest.row.lastSeen,
      lastSeen: latest.row.lastSeen,
      estimated: true
    });
  }
  // More unlogged usage than the session's net difference means the two sources disagree.
  if (estimates.length === 0 || estimatedTotal > sessionGap) return null;

  return {
    path: `${withCostState.path}#estimated`,
    daily: { [latest.date]: estimates },
    dailyEventCounts: { [latest.date]: 0 },
    dailySessionCounts: { [latest.date]: 0 },
    dailyPriority: withCostState.dailyPriority,
    dailyCoverageKey: withCostState.dailyCoverageKey,
    events: [],
    rateLimits: [],
    latestRateLimit: null,
    parseErrors: 0,
    tokenEvents: 0
  };
};

/**
 * Estimates usage Claude Code reported in cost-state records but never logged as requests, such
 * as prompt suggestions and session titles. Each estimate is dated to its session's last activity
 * because cost-state has no per-day breakdown.
 */
export const estimateClaudeUnloggedUsage = (summaries: Record<string, ParsedFileSummary>): Record<string, ParsedFileSummary> => {
  const bySession = new Map<string, ParsedFileSummary[]>();
  for (const summary of Object.values(summaries)) {
    if (!summary.claudeSessionId) continue;
    const transcripts = bySession.get(summary.claudeSessionId) ?? [];
    transcripts.push(summary);
    bySession.set(summary.claudeSessionId, transcripts);
  }

  const estimates: Record<string, ParsedFileSummary> = {};
  for (const transcripts of bySession.values()) {
    const estimate = estimateSession(transcripts);
    if (estimate) estimates[estimate.path] = estimate;
  }
  return estimates;
};
