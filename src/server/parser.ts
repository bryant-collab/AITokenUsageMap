import fs from "node:fs";
import readline from "node:readline";
import zlib from "node:zlib";
import type { RateLimitSnapshot, SessionDayTotal, TokenUsage } from "../shared/types";
import { addUsage, emptyUsage, subtractUsage } from "../shared/tokenMath";
import { toLocalDate } from "./dateUtils";

// Subagent and forked rollouts open by replaying their parent's token events within milliseconds.
// No model response can finish this quickly, so these events are history, not new requests.
const REPLAY_WINDOW_MS = 1_000;

type RawUsage = {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
};

export type ParsedFileSummary = {
  path: string;
  daily: Record<string, SessionDayTotal[]>;
  dailyEventCounts?: Record<string, number>;
  dailySessionCounts?: Record<string, number>;
  dailyPriority?: number;
  dailyCoverageKey?: string;
  events: Array<{
    timestamp: string;
    usage: TokenUsage;
  }>;
  rateLimits: RateLimitSnapshot[];
  latestRateLimit: RateLimitSnapshot | null;
  parseErrors: number;
  tokenEvents: number;
  /** Claude session this transcript belongs to; subagent transcripts use their parent session's id. */
  claudeSessionId?: string;
  /** The session's last cost-state record, which totals usage per model across its transcripts. */
  claudeCostState?: {
    modelUsage: Record<string, TokenUsage>;
  };
  /** The transcript contains records copied from a forked parent session. */
  claudeForked?: boolean;
};

const rawUsageToUsage = (raw: RawUsage | null | undefined): TokenUsage | null => {
  if (!raw) return null;
  return {
    inputTokens: Number(raw.input_tokens ?? 0),
    cachedInputTokens: Number(raw.cached_input_tokens ?? raw.cache_read_input_tokens ?? 0),
    outputTokens: Number(raw.output_tokens ?? 0),
    reasoningOutputTokens: Number(raw.reasoning_output_tokens ?? 0),
    totalTokens: Number(raw.total_tokens ?? 0)
  };
};

const readModelHint = (payload: Record<string, unknown>, fallback: string): string => {
  const direct = payload.model ?? payload.model_name ?? payload.model_id;
  if (typeof direct === "string" && direct.trim()) return direct;
  const nested = payload.payload;
  if (nested && typeof nested === "object") {
    const model = (nested as Record<string, unknown>).model;
    if (typeof model === "string" && model.trim()) return model;
  }
  return fallback;
};

const latestSnapshot = (timestamp: string, rateLimits: Record<string, any> | null | undefined): RateLimitSnapshot | null => {
  if (!rateLimits) return null;
  return {
    timestamp,
    limitId: typeof rateLimits.limit_id === "string" ? rateLimits.limit_id : null,
    planType: typeof rateLimits.plan_type === "string" ? rateLimits.plan_type : null,
    primary: rateLimits.primary
      ? {
          usedPercent: Number.isFinite(rateLimits.primary.used_percent) ? Number(rateLimits.primary.used_percent) : null,
          windowMinutes: Number.isFinite(rateLimits.primary.window_minutes) ? Number(rateLimits.primary.window_minutes) : null,
          resetsAt: Number.isFinite(rateLimits.primary.resets_at) ? Number(rateLimits.primary.resets_at) : null
        }
      : null,
    secondary: rateLimits.secondary
      ? {
          usedPercent: Number.isFinite(rateLimits.secondary.used_percent) ? Number(rateLimits.secondary.used_percent) : null,
          windowMinutes: Number.isFinite(rateLimits.secondary.window_minutes) ? Number(rateLimits.secondary.window_minutes) : null,
          resetsAt: Number.isFinite(rateLimits.secondary.resets_at) ? Number(rateLimits.secondary.resets_at) : null
        }
      : null
  };
};

const createSessionTotal = (
  sessionId: string,
  cwd: string | null,
  source: string | null,
  originator: string | null,
  cliVersion: string | null,
  model: string,
  timestamp: string
): SessionDayTotal => ({
  ...emptyUsage(),
  sessionId,
  cwd,
  source,
  originator,
  cliVersion,
  model,
  events: 0,
  firstSeen: timestamp,
  lastSeen: timestamp
});

const openRolloutStream = (filePath: string): NodeJS.ReadableStream => {
  const file = fs.createReadStream(filePath);
  if (!filePath.endsWith(".zst")) return file.setEncoding("utf8");
  const decompress = zlib.createZstdDecompress();
  file.on("error", (error) => decompress.destroy(error));
  return file.pipe(decompress).setEncoding("utf8");
};

export const parseRolloutFile = async (filePath: string, timezone: string): Promise<ParsedFileSummary> => {
  const stream = openRolloutStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const daily: Record<string, SessionDayTotal[]> = {};
  const sessionByDayAndModel = new Map<string, SessionDayTotal>();
  const seenEvents = new Set<string>();
  let sessionId = filePath;
  let cwd: string | null = null;
  let source: string | null = null;
  let originator: string | null = null;
  let cliVersion: string | null = null;
  let model = "unknown";
  let previousTotal: TokenUsage | null = null;
  let inheritsHistory = false;
  let sessionStartMs: number | null = null;
  let replayEnded = false;
  let usageRecordPending = false;
  let parseErrors = 0;
  let tokenEvents = 0;
  let latestRateLimit: RateLimitSnapshot | null = null;
  const events: ParsedFileSummary["events"] = [];
  const rateLimits: RateLimitSnapshot[] = [];

  const addRequestUsage = (timestamp: string, usage: TokenUsage): void => {
    const date = toLocalDate(timestamp, timezone);
    const key = `${date}|${sessionId}|${model}`;
    let total = sessionByDayAndModel.get(key);
    if (!total) {
      total = createSessionTotal(sessionId, cwd, source, originator, cliVersion, model, timestamp);
      sessionByDayAndModel.set(key, total);
      daily[date] ??= [];
      daily[date].push(total);
    }

    addUsage(total, usage);
    total.events += 1;
    total.lastSeen = timestamp;
    events.push({ timestamp, usage });
    tokenEvents += 1;
  };

  for await (const line of rl) {
    if (
      !line.includes("\"session_meta\"")
      && !line.includes("\"turn_context\"")
      && !line.includes("\"token_count\"")
      && !line.includes("\"token_usage_record\"")
    ) {
      continue;
    }

    let record: any;
    try {
      record = JSON.parse(line);
    } catch {
      parseErrors += 1;
      continue;
    }

    const payload = record?.payload;
    if (record?.type === "session_meta" && payload) {
      sessionId = String(payload.id ?? sessionId);
      cwd = typeof payload.cwd === "string" ? payload.cwd : cwd;
      source = typeof payload.source === "string" ? payload.source : source;
      originator = typeof payload.originator === "string" ? payload.originator : originator;
      cliVersion = typeof payload.cli_version === "string" ? payload.cli_version : cliVersion;
      model = readModelHint(payload, model);
      inheritsHistory = Boolean(payload.parent_thread_id ?? payload.forked_from_id)
        || (typeof payload.source === "object" && payload.source !== null);
      sessionStartMs ??= Date.parse(record.timestamp);
      continue;
    }

    if (record?.type === "turn_context" && payload) {
      model = readModelHint(payload, model);
      continue;
    }

    // Usage records give each request's exact usage. A heavy request can be followed by a token event
    // that reports a much smaller figure, so records win when a rollout has them.
    if (record?.type === "token_usage_record") {
      const usage = rawUsageToUsage(payload?.usage);
      if (!usage || usage.totalTokens <= 0 || (payload.thread_id && payload.thread_id !== sessionId)) continue;
      replayEnded = true;
      usageRecordPending = true;
      const responseKey = `response:${payload.response_id ?? record.timestamp}`;
      if (seenEvents.has(responseKey)) continue;
      seenEvents.add(responseKey);
      addRequestUsage(record.timestamp, usage);
      continue;
    }

    if (record?.type !== "event_msg" || payload?.type !== "token_count") continue;

    const snapshot = latestSnapshot(record.timestamp, payload.rate_limits);
    if (snapshot) {
      latestRateLimit = snapshot;
      rateLimits.push(snapshot);
    }
    if (!payload.info) continue;

    const lastUsage = rawUsageToUsage(payload.info.last_token_usage);
    const totalUsage = rawUsageToUsage(payload.info.total_token_usage);
    const usage = lastUsage ?? (totalUsage && previousTotal ? subtractUsage(totalUsage, previousTotal) : totalUsage);
    const isReplay = inheritsHistory
      && !replayEnded
      && sessionStartMs !== null
      && Date.parse(record.timestamp) - sessionStartMs < REPLAY_WINDOW_MS;
    // Codex re-emits the latest usage without a new request, leaving the cumulative total unchanged.
    const isRepeat = totalUsage !== null
      && previousTotal !== null
      && totalUsage.totalTokens === previousTotal.totalTokens;
    const alreadyCounted = usageRecordPending;
    if (!isReplay) replayEnded = true;
    usageRecordPending = false;
    if (totalUsage) previousTotal = totalUsage;
    if (alreadyCounted || isReplay || isRepeat || !usage || usage.totalTokens <= 0) continue;

    const dedupKey = `${record.timestamp}:${totalUsage?.inputTokens ?? usage.inputTokens}+${totalUsage?.outputTokens ?? usage.outputTokens}+${totalUsage?.totalTokens ?? usage.totalTokens}`;
    if (seenEvents.has(dedupKey)) continue;
    seenEvents.add(dedupKey);

    addRequestUsage(record.timestamp, usage);
  }

  return {
    path: filePath,
    daily,
    events,
    rateLimits,
    latestRateLimit,
    parseErrors,
    tokenEvents
  };
};
