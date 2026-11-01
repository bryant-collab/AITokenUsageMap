import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import type { SessionDayTotal, TokenUsage } from "../shared/types";
import { addUsage, emptyUsage } from "../shared/tokenMath";
import { toLocalDate } from "./dateUtils";
import type { ParsedFileSummary } from "./parser";

type ClaudeStatsCache = {
  dailyActivity?: unknown;
  dailyModelTokens?: unknown;
  modelUsage?: unknown;
};

type ParsedClaudeTranscriptRecord = {
  timestamp: string;
  sessionId: string;
  cwd: string | null;
  model: string;
  cliVersion: string | null;
  dedupKey: string;
  usage: TokenUsage;
};

const numberFrom = (...values: unknown[]): number => {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return 0;
};

const firstString = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
};

const firstObject = (...values: unknown[]): Record<string, unknown> => {
  for (const value of values) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return {};
};

const timestampFrom = (...values: unknown[]): string | null => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      const parsed = new Date(value);
      if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return new Date(value).toISOString();
    }
  }
  return null;
};

const dayTimestamp = (date: string): string => `${date}T12:00:00.000Z`;

const usageFromParts = (inputTokens: number, cachedInputTokens: number, outputTokens: number, totalTokens?: number): TokenUsage => ({
  inputTokens,
  cachedInputTokens,
  outputTokens,
  reasoningOutputTokens: 0,
  totalTokens: totalTokens ?? inputTokens + cachedInputTokens + outputTokens
});

const withCacheWrites = (usage: TokenUsage, write5mTokens: number, write1hTokens: number): TokenUsage => {
  if (write5mTokens > 0) usage.cacheWrite5mTokens = write5mTokens;
  if (write1hTokens > 0) usage.cacheWrite1hTokens = write1hTokens;
  return usage;
};

const totalFromUnknown = (value: unknown): number => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;

  const object = value as Record<string, unknown>;
  const explicit = numberFrom(object.totalTokens, object.total_tokens, object.tokens);
  if (explicit > 0) return explicit;

  const inputTokens = numberFrom(object.inputTokens, object.input_tokens);
  const explicitCachedInputTokens = numberFrom(
    object.cachedInputTokens,
    object.cached_input_tokens
  );
  const splitCachedInputTokens = numberFrom(
    object.cacheReadInputTokens,
    object.cache_read_input_tokens
  ) + numberFrom(object.cacheCreationInputTokens, object.cache_creation_input_tokens);
  const cachedInputTokens = explicitCachedInputTokens || splitCachedInputTokens;
  const outputTokens = numberFrom(object.outputTokens, object.output_tokens);
  return inputTokens + cachedInputTokens + outputTokens;
};

const usageFromClaudeUsage = (usage: Record<string, unknown>): TokenUsage | null => {
  const inputTokens = numberFrom(usage.inputTokens, usage.input_tokens);
  const cacheReadInputTokens = numberFrom(usage.cacheReadInputTokens, usage.cache_read_input_tokens);
  const cacheCreationInputTokens = numberFrom(usage.cacheCreationInputTokens, usage.cache_creation_input_tokens);
  const cachedInputTokens = numberFrom(usage.cachedInputTokens, usage.cached_input_tokens) || cacheReadInputTokens + cacheCreationInputTokens;
  const outputTokens = numberFrom(usage.outputTokens, usage.output_tokens);
  const totalTokens = numberFrom(usage.totalTokens, usage.total_tokens) || inputTokens + cachedInputTokens + outputTokens;

  if (totalTokens <= 0) return null;
  const cacheCreation = firstObject(usage.cache_creation);
  // Writes with no reported duration use the shorter, default cache lifetime.
  const cacheWrite1hTokens = Math.min(
    cacheCreationInputTokens,
    numberFrom(usage.cacheCreationEphemeral1hInputTokens, cacheCreation.ephemeral_1h_input_tokens)
  );
  return withCacheWrites(
    usageFromParts(inputTokens, cachedInputTokens, outputTokens, totalTokens),
    cacheCreationInputTokens - cacheWrite1hTokens,
    cacheWrite1hTokens
  );
};

const modelUsageBreakdowns = (modelUsage: unknown): Map<string, TokenUsage> => {
  const breakouts = new Map<string, TokenUsage>();
  if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) return breakouts;

  for (const [model, value] of Object.entries(modelUsage as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const usage = usageFromClaudeUsage(value as Record<string, unknown>);
    if (usage) breakouts.set(model, usage);
  }

  return breakouts;
};

const scaleUsageToTotal = (breakdown: TokenUsage | undefined, totalTokens: number): TokenUsage => {
  if (!breakdown || totalTokens <= 0) return usageFromParts(0, 0, 0, totalTokens);

  const basis = breakdown.inputTokens + breakdown.cachedInputTokens + breakdown.outputTokens;
  if (basis <= 0) return usageFromParts(0, 0, 0, totalTokens);

  const inputTokens = Math.round((totalTokens * breakdown.inputTokens) / basis);
  const cachedInputTokens = Math.round((totalTokens * breakdown.cachedInputTokens) / basis);
  const outputTokens = Math.max(0, totalTokens - inputTokens - cachedInputTokens);
  return withCacheWrites(
    usageFromParts(inputTokens, cachedInputTokens, outputTokens, totalTokens),
    Math.round((totalTokens * (breakdown.cacheWrite5mTokens ?? 0)) / basis),
    Math.round((totalTokens * (breakdown.cacheWrite1hTokens ?? 0)) / basis)
  );
};

const transcriptSessionId = (filePath: string): string => {
  const parent = path.dirname(filePath);
  return path.basename(parent) === "subagents"
    ? path.basename(path.dirname(parent))
    : path.basename(filePath, ".jsonl");
};

const claudeCoverageKey = (filePath: string): string => {
  if (path.basename(filePath) === "stats-cache.json") return path.dirname(filePath);
  const marker = `${path.sep}projects${path.sep}`;
  const markerIndex = filePath.indexOf(marker);
  return markerIndex >= 0 ? filePath.slice(0, markerIndex) : path.dirname(filePath);
};

const createSessionTotal = (
  sessionId: string,
  cwd: string | null,
  source: string,
  model: string,
  cliVersion: string | null,
  timestamp: string
): SessionDayTotal => ({
  ...emptyUsage(),
  sessionId,
  cwd,
  source,
  originator: "claude-code",
  cliVersion,
  model,
  events: 0,
  firstSeen: timestamp,
  lastSeen: timestamp
});

const parseStatsCacheFile = async (filePath: string): Promise<ParsedFileSummary> => {
  const text = await fs.promises.readFile(filePath, "utf8");
  const cache = JSON.parse(text) as ClaudeStatsCache;
  const daily: Record<string, SessionDayTotal[]> = {};
  const dailyEventCounts: Record<string, number> = {};
  const dailySessionCounts: Record<string, number> = {};
  const modelBreakdowns = modelUsageBreakdowns(cache.modelUsage);
  let tokenEvents = 0;

  if (Array.isArray(cache.dailyActivity)) {
    for (const activity of cache.dailyActivity) {
      if (!activity || typeof activity !== "object" || Array.isArray(activity)) continue;
      const item = activity as Record<string, unknown>;
      const date = firstString(item.date);
      if (!date) continue;
      const messageCount = numberFrom(item.messageCount, item.message_count);
      const sessionCount = numberFrom(item.sessionCount, item.session_count);
      if (messageCount > 0) dailyEventCounts[date] = messageCount;
      if (sessionCount > 0) dailySessionCounts[date] = sessionCount;
    }
  }

  if (Array.isArray(cache.dailyModelTokens)) {
    for (const day of cache.dailyModelTokens) {
      if (!day || typeof day !== "object" || Array.isArray(day)) continue;
      const item = day as Record<string, unknown>;
      const date = firstString(item.date);
      const tokensByModel = firstObject(item.tokensByModel, item.tokens_by_model, item.models);
      if (!date || Object.keys(tokensByModel).length === 0) continue;

      for (const [model, rawTokens] of Object.entries(tokensByModel)) {
        const totalTokens = totalFromUnknown(rawTokens);
        if (totalTokens <= 0) continue;
        const timestamp = dayTimestamp(date);
        const session = createSessionTotal(`claude-stats-${date}-${model}`, null, filePath, model, null, timestamp);
        addUsage(session, scaleUsageToTotal(modelBreakdowns.get(model), totalTokens));
        session.events = 1;
        daily[date] ??= [];
        daily[date].push(session);
        tokenEvents += 1;
      }

      if (daily[date] && !dailyEventCounts[date]) {
        dailyEventCounts[date] = daily[date].reduce((sum, session) => sum + session.events, 0);
      }
    }
  }

  return {
    path: filePath,
    daily,
    dailyEventCounts,
    dailySessionCounts,
    dailyPriority: 2,
    dailyCoverageKey: claudeCoverageKey(filePath),
    events: [],
    rateLimits: [],
    latestRateLimit: null,
    parseErrors: 0,
    tokenEvents: Object.values(dailyEventCounts).reduce((sum, count) => sum + count, 0) || tokenEvents
  };
};

const parseTranscriptRecord = (record: Record<string, unknown>, filePath: string): ParsedClaudeTranscriptRecord | null => {
  if (record.type !== "assistant") return null;

  const message = firstObject(record.message);
  const usage = usageFromClaudeUsage(firstObject(message.usage, record.usage));
  if (!usage) return null;

  const timestamp = timestampFrom(record.timestamp, record.created_at, message.timestamp) ?? new Date().toISOString();
  const sessionId = firstString(record.sessionId, record.session_id, message.sessionId, message.session_id) ?? path.basename(filePath, ".jsonl");
  const model = firstString(message.model, record.model, record.modelName, record.model_name) ?? "unknown";
  const cwd = firstString(record.cwd, record.projectPath, record.project_path) ?? path.basename(path.dirname(filePath));
  const cliVersion = firstString(record.version, record.claudeVersion, record.claude_version);
  const requestId = firstString(record.requestId, record.request_id, message.id, record.uuid);
  const dedupKey = requestId
    ? `id:${requestId}`
    : `${timestamp}:${sessionId}:${model}:${usage.inputTokens}:${usage.cachedInputTokens}:${usage.outputTokens}:${usage.totalTokens}`;

  return {
    timestamp,
    sessionId,
    cwd,
    model,
    cliVersion,
    dedupKey,
    usage
  };
};

const parseTranscriptFile = async (filePath: string, timezone: string): Promise<ParsedFileSummary> => {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const daily: Record<string, SessionDayTotal[]> = {};
  const sessionByDayAndModel = new Map<string, SessionDayTotal>();
  const seenEvents = new Set<string>();
  const events: ParsedFileSummary["events"] = [];
  const sessionId = transcriptSessionId(filePath);
  let costState: ParsedFileSummary["claudeCostState"];
  let forked = false;
  let parseErrors = 0;
  let tokenEvents = 0;

  for await (const line of rl) {
    const mayHaveUsage = line.includes("\"assistant\"") && line.includes("\"usage\"");
    const mayHaveSessionMetadata = line.includes("\"cost-state\"") || line.includes("\"forkedFrom\"");
    if (!mayHaveUsage && !mayHaveSessionMetadata) continue;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      parseErrors += 1;
      continue;
    }

    if (record.forkedFrom) forked = true;
    if (record.type === "cost-state") {
      // Claude Code rewrites this cumulative record, so only the last one in a transcript counts.
      if (record.sessionId === sessionId) {
        costState = { modelUsage: Object.fromEntries(modelUsageBreakdowns(record.modelUsage)) };
      }
      continue;
    }
    if (!mayHaveUsage) continue;

    const parsed = parseTranscriptRecord(record, filePath);
    if (!parsed || seenEvents.has(parsed.dedupKey)) continue;
    seenEvents.add(parsed.dedupKey);

    const date = toLocalDate(parsed.timestamp, timezone);
    const key = `${date}|${parsed.sessionId}|${parsed.model}`;
    let total = sessionByDayAndModel.get(key);
    if (!total) {
      total = createSessionTotal(parsed.sessionId, parsed.cwd, filePath, parsed.model, parsed.cliVersion, parsed.timestamp);
      sessionByDayAndModel.set(key, total);
      daily[date] ??= [];
      daily[date].push(total);
    }

    addUsage(total, parsed.usage);
    total.events += 1;
    total.lastSeen = parsed.timestamp;
    events.push({ timestamp: parsed.timestamp, usage: parsed.usage });
    tokenEvents += 1;
  }

  return {
    path: filePath,
    daily,
    dailyPriority: 1,
    dailyCoverageKey: claudeCoverageKey(filePath),
    events,
    rateLimits: [],
    latestRateLimit: null,
    parseErrors,
    tokenEvents,
    claudeSessionId: sessionId,
    ...(costState && { claudeCostState: costState }),
    ...(forked && { claudeForked: true })
  };
};

export const parseClaudeUsageFile = async (filePath: string, timezone: string): Promise<ParsedFileSummary> => (
  path.basename(filePath) === "stats-cache.json"
    ? parseStatsCacheFile(filePath)
    : parseTranscriptFile(filePath, timezone)
);
