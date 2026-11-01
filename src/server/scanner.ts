import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { DashboardResponse, DayTotal, Diagnostics, HarnessId, HarnessInfo, ModelUsageRangeResponse, ModelUsageRangeRow, RateLimitSnapshot, SessionDayTotal, SummaryResponse, TokenUsage, WeeklyTotal } from "../shared/types";
import { addUsage, emptyUsage } from "../shared/tokenMath";
import { addDays, startOfWeek, todayInZone, toLocalDate } from "./dateUtils";
import { appConfig } from "./config";
import { parseRolloutFile, type ParsedFileSummary } from "./parser";
import { parseCopilotDebugFile } from "./copilotParser";
import { parseClaudeUsageFile } from "./claudeParser";
import { estimateClaudeUnloggedUsage } from "./claudeReconcile";

// Bump when parsed summaries gain fields so cached files are parsed again.
const CACHE_VERSION = 4;

type CacheEntry = {
  key: string;
  summary: ParsedFileSummary;
};

type CacheFile = {
  version: typeof CACHE_VERSION;
  entries: Record<string, CacheEntry>;
};

type HarnessStore = {
  files: Record<string, ParsedFileSummary>;
  diagnostics: Diagnostics;
  scannedAt: string | null;
};

type HarnessConfig = {
  info: HarnessInfo;
  roots: string[];
  collectFiles: (roots: string[]) => Promise<string[]>;
  parseFile: (filePath: string, timezone: string) => Promise<ParsedFileSummary>;
  estimateFiles?: (summaries: Record<string, ParsedFileSummary>) => Record<string, ParsedFileSummary>;
};

const emptyDiagnostics = (): Diagnostics => ({
  filesScanned: 0,
  filesFromCache: 0,
  filesParsed: 0,
  skippedFiles: 0,
  parseErrors: 0,
  tokenEvents: 0,
  lastScanStartedAt: null,
  lastScanCompletedAt: null
});

const harnesses: Record<HarnessId, HarnessConfig> = {
  codex: {
    info: {
      id: "codex",
      name: "Codex",
      description: "Observed local token usage from Codex session logs.",
      usageLabel: "Observed local tokens",
      confidence: {
        captured: "High for local Codex session logs that still exist on this machine.",
        total: "Medium for total personal Codex usage because deleted logs, other machines, and cloud or web sessions can be missed.",
        billing: "Low for billing reconciliation because provider billing and rate-limit accounting use server-side records."
      },
      caveats: [
        "Input, cached input, output, and reasoning output come from local token_count events; older or partial records may only expose cumulative totals.",
        "Totals follow the values reported by Codex logs when present, so reasoning output may be a separate diagnostic field rather than an additive extra.",
        "History that subagent and forked sessions replay from their parent, and token events Codex repeats without a new request, are not counted again.",
        "Local files do not prove account-wide usage, billing usage, or usage from other devices."
      ]
    },
    roots: appConfig.codexRoots,
    collectFiles: async (roots) => {
      // Codex compresses older rollouts, and a rollout can briefly exist in both forms.
      const files = await collectMatchingFiles(roots, (entry) => entry.name.startsWith("rollout-") && /\.jsonl(\.zst)?$/.test(entry.name));
      const uncompressed = new Set(files.filter((file) => file.endsWith(".jsonl")));
      return files.filter((file) => !file.endsWith(".zst") || !uncompressed.has(file.slice(0, -".zst".length)));
    },
    parseFile: parseRolloutFile
  },
  "github-copilot": {
    info: {
      id: "github-copilot",
      name: "GitHub Copilot",
      description: "Estimated local token usage from VS Code Copilot Chat debug logs.",
      usageLabel: "Estimated local tokens",
      confidence: {
        captured: "High for captured local VS Code Copilot Chat and agent requests when debug logs include token fields.",
        total: "Medium for total personal Copilot usage because completions, GitHub.com, CLI, other IDEs, remote environments, disabled logging, and log rotation can be missed.",
        billing: "Low for billing reconciliation because GitHub bills pooled overages in AI Credits with server-side pricing, entitlements, and adjustments."
      },
      caveats: [
        "VS Code debug logs and Copilot CLI session files are local diagnostic/session data; token field names and availability can change between Copilot versions.",
        "Copilot CLI per-model totals come from completed session shutdown aggregates; active sessions, including subagents, may not show complete model usage until the CLI session exits.",
        "Some Copilot activity is not captured here, including inline completions, GitHub.com, other IDEs, remote sessions, disabled logging, deleted sessions, and rotated logs.",
        "AI Credit billing depends on server-side pricing, model multipliers, entitlements, and adjustments, so local token splits are not a bill."
      ]
    },
    roots: appConfig.copilotRoots,
    collectFiles: async (roots) => collectMatchingFiles(roots, (entry, fullPath) => (
      entry.name.endsWith(".jsonl")
      && fullPath.includes(`${path.sep}GitHub.copilot-chat${path.sep}debug-logs${path.sep}`)
    ) || (
      entry.name === "events.jsonl"
      && fullPath.includes(`${path.sep}session-state${path.sep}`)
    )),
    parseFile: parseCopilotDebugFile
  },
  "claude-code": {
    info: {
      id: "claude-code",
      name: "Claude Code",
      description: "Estimated local token usage from Claude Code /usage aggregates and session transcripts.",
      usageLabel: "Estimated local tokens",
      confidence: {
        captured: "Medium-high for local Claude Code /usage aggregates in stats-cache.json when present; lower for transcript-derived session detail because JSONL token fields can be version-sensitive.",
        total: "Medium for total personal Claude Code usage because other machines, cloud sessions, disabled persistence, transcript cleanup, and alternate config directories can be missed.",
        billing: "Low for billing reconciliation because Claude Code local cost and token figures are estimates and provider billing uses server-side accounting."
      },
      caveats: [
        "Daily Claude Code totals prefer stats-cache.json, which is an aggregate cache; daily input/output splits may be proportioned from model-level breakdowns when exact daily splits are unavailable.",
        "Transcript-derived session detail can undercount on some Claude Code versions and may disappear after cleanup or when session persistence is disabled.",
        "Claude cache read and cache creation tokens are merged into Cached input in this dashboard, but cost estimates price cache writes separately.",
        "Claude Code does not log every request. Prompt suggestions and session titles are added as estimated rows, dated to the session's last activity, using the cost-state total written when a session exits. Sessions that are still running, ended without that record, or were forked have no estimate."
      ]
    },
    roots: appConfig.claudeRoots,
    collectFiles: async (roots) => collectMatchingFiles(roots, (entry, fullPath) => (
      entry.name === "stats-cache.json"
      || (entry.name.endsWith(".jsonl") && fullPath.includes(`${path.sep}projects${path.sep}`))
    )),
    parseFile: parseClaudeUsageFile,
    estimateFiles: estimateClaudeUnloggedUsage
  }
};

const stores: Record<HarnessId, HarnessStore> = {
  codex: {
    files: {},
    diagnostics: emptyDiagnostics(),
    scannedAt: null
  },
  "github-copilot": {
    files: {},
    diagnostics: emptyDiagnostics(),
    scannedAt: null
  },
  "claude-code": {
    files: {},
    diagnostics: emptyDiagnostics(),
    scannedAt: null
  }
};

const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const readCache = async (): Promise<CacheFile> => {
  try {
    const text = await fs.readFile(appConfig.cachePath, "utf8");
    const cache = JSON.parse(text) as CacheFile;
    return cache.version === CACHE_VERSION ? cache : { version: CACHE_VERSION, entries: {} };
  } catch {
    return { version: CACHE_VERSION, entries: {} };
  }
};

const writeCache = async (cache: CacheFile): Promise<void> => {
  await fs.mkdir(path.dirname(appConfig.cachePath), { recursive: true });
  await fs.writeFile(appConfig.cachePath, JSON.stringify(cache, null, 2), "utf8");
};

const collectMatchingFiles = async (roots: string[], matches: (entry: Dirent, fullPath: string) => boolean): Promise<string[]> => {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && matches(entry, fullPath)) {
        files.push(fullPath);
      }
    }
  };

  for (const root of roots) {
    await walk(root);
  }
  return files.sort();
};

const cacheKeyFor = async (filePath: string): Promise<string> => {
  const stat = await fs.stat(filePath);
  return `${stat.size}:${stat.mtimeMs}`;
};

export const scanHarnessLogs = async (harnessId: HarnessId, force = false): Promise<Diagnostics> => {
  const harness = harnesses[harnessId];
  const store = stores[harnessId];
  const diagnostics = emptyDiagnostics();
  diagnostics.lastScanStartedAt = new Date().toISOString();
  const cache = await readCache();
  const files = await harness.collectFiles(harness.roots);
  diagnostics.filesScanned = files.length;
  const nextCache: CacheFile = { version: CACHE_VERSION, entries: { ...cache.entries } };
  const summaries: Record<string, ParsedFileSummary> = {};

  for (const filePath of files) {
    try {
      const key = await cacheKeyFor(filePath);
      const cachePath = `${harnessId}:${filePath}`;
      const cached = force ? undefined : cache.entries[cachePath];
      if (cached?.key === key) {
        summaries[filePath] = cached.summary;
        nextCache.entries[cachePath] = cached;
        diagnostics.filesFromCache += 1;
      } else {
        const summary = await harness.parseFile(filePath, appConfig.timezone);
        summaries[filePath] = summary;
        nextCache.entries[cachePath] = { key, summary };
        diagnostics.filesParsed += 1;
      }
    } catch {
      diagnostics.skippedFiles += 1;
    }
  }

  for (const summary of Object.values(summaries)) {
    diagnostics.parseErrors += summary.parseErrors;
    diagnostics.tokenEvents += summary.tokenEvents;
  }
  diagnostics.lastScanCompletedAt = new Date().toISOString();
  await writeCache(nextCache);

  // Estimates depend on every transcript in a session, so they stay out of the per-file cache.
  store.files = { ...summaries, ...harness.estimateFiles?.(summaries) };
  store.diagnostics = diagnostics;
  store.scannedAt = diagnostics.lastScanCompletedAt;
  return diagnostics;
};

export const scanAllLogs = async (force = false): Promise<Record<HarnessId, Diagnostics>> => {
  const result = {} as Record<HarnessId, Diagnostics>;
  for (const harnessId of Object.keys(harnesses) as HarnessId[]) {
    result[harnessId] = await scanHarnessLogs(harnessId, force);
  }
  return result;
};

export const ensureScanned = async (): Promise<void> => {
  for (const harnessId of Object.keys(harnesses) as HarnessId[]) {
    if (!stores[harnessId].scannedAt) {
      await scanHarnessLogs(harnessId, false);
    }
  }
};

const buildDaily = (store: HarnessStore): Map<string, DayTotal> => {
  const daily = new Map<string, DayTotal>();
  const priorities = dailyPrioritiesFor(store);
  for (const summary of Object.values(store.files)) {
    for (const [date, sessions] of Object.entries(summary.daily)) {
      if (!usesDailySummary(summary, date, priorities)) continue;
      let total = daily.get(date);
      if (!total) {
        total = { ...emptyUsage(), date, events: 0, sessions: 0 };
        daily.set(date, total);
      }
      const sessionIds = new Set<string>();
      let sessionEvents = 0;
      for (const session of sessions) {
        addUsage(total, session);
        sessionEvents += session.events;
        sessionIds.add(session.sessionId);
      }
      total.events += summary.dailyEventCounts?.[date] ?? sessionEvents;
      total.sessions += summary.dailySessionCounts?.[date] ?? sessionIds.size;
    }
  }
  return daily;
};

const dailyPriority = (summary: ParsedFileSummary): number => summary.dailyPriority ?? 0;

const dailyCoverageKey = (summary: ParsedFileSummary): string => summary.dailyCoverageKey ?? summary.path;

const dailyPriorityKey = (summary: ParsedFileSummary, date: string): string => `${dailyCoverageKey(summary)}|${date}`;

const dailyPrioritiesFor = (store: HarnessStore): Map<string, number> => {
  const priorities = new Map<string, number>();
  for (const summary of Object.values(store.files)) {
    for (const date of Object.keys(summary.daily)) {
      const key = dailyPriorityKey(summary, date);
      priorities.set(key, Math.max(priorities.get(key) ?? Number.NEGATIVE_INFINITY, dailyPriority(summary)));
    }
  }
  return priorities;
};

const usesDailySummary = (summary: ParsedFileSummary, date: string, priorities: Map<string, number>): boolean => (
  dailyPriority(summary) >= (priorities.get(dailyPriorityKey(summary, date)) ?? dailyPriority(summary))
);

const buildWeekly = (days: DayTotal[]): WeeklyTotal[] => {
  const weekly = new Map<string, WeeklyTotal>();
  for (const day of days) {
    const weekStart = startOfWeek(day.date);
    let total = weekly.get(weekStart);
    if (!total) {
      total = { ...emptyUsage(), weekStart, events: 0 };
      weekly.set(weekStart, total);
    }
    addUsage(total, day);
    total.events += day.events;
  }
  return [...weekly.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));
};

const latestRateLimit = (store: HarnessStore): RateLimitSnapshot | null => {
  return Object.values(store.files)
    .map((summary) => summary.latestRateLimit)
    .filter((snapshot): snapshot is RateLimitSnapshot => Boolean(snapshot))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null;
};

const latestRateLimitForDay = (store: HarnessStore, date: string): RateLimitSnapshot | null => {
  return Object.values(store.files)
    .flatMap((summary) => summary.rateLimits ?? [])
    .filter((snapshot) => toLocalDate(snapshot.timestamp, appConfig.timezone) === date)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0] ?? null;
};

const lastHourUsage = (store: HarnessStore): TokenUsage => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const total = emptyUsage();
  for (const summary of Object.values(store.files)) {
    for (const event of summary.events) {
      if (new Date(event.timestamp).getTime() >= oneHourAgo) {
        addUsage(total, event.usage);
      }
    }
  }
  return total;
};

const hasHarnessData = (summary: SummaryResponse): boolean => (
  summary.diagnostics.filesScanned > 0 || summary.diagnostics.tokenEvents > 0 || summary.totals.totalTokens > 0
);

export const getHarnessSummary = async (harnessId: HarnessId, from?: string, to?: string): Promise<SummaryResponse> => {
  await ensureScanned();
  const harness = harnesses[harnessId];
  const store = stores[harnessId];
  const today = todayInZone(appConfig.timezone);
  const rangeTo = to ?? today;
  const rangeFrom = from ?? addDays(rangeTo, -364);
  const allDaily = buildDaily(store);
  const daily = [...allDaily.values()]
    .filter((day) => day.date >= rangeFrom && day.date <= rangeTo)
    .sort((a, b) => a.date.localeCompare(b.date));
  const totals = daily.reduce((acc, day) => addUsage(acc, day), emptyUsage());
  const lastSevenDays = daily
    .filter((day) => day.date >= addDays(today, -6) && day.date <= today)
    .reduce((acc, day) => addUsage(acc, day), emptyUsage());

  return {
    harness: harness.info,
    range: { from: rangeFrom, to: rangeTo, timezone: appConfig.timezone },
    totals,
    today: allDaily.get(today) ?? null,
    lastHour: lastHourUsage(store),
    lastSevenDays,
    peakDay: daily.reduce<DayTotal | null>((peak, day) => (!peak || day.totalTokens > peak.totalTokens ? day : peak), null),
    daily,
    weekly: buildWeekly(daily),
    latestRateLimit: latestRateLimit(store),
    diagnostics: store.diagnostics
  };
};

export const getSummary = async (from?: string, to?: string): Promise<DashboardResponse> => {
  await ensureScanned();
  const today = todayInZone(appConfig.timezone);
  const rangeTo = to ?? today;
  const rangeFrom = from ?? addDays(rangeTo, -364);
  const summaries = await Promise.all((Object.keys(harnesses) as HarnessId[]).map((harnessId) => getHarnessSummary(harnessId, rangeFrom, rangeTo)));
  return {
    range: { from: rangeFrom, to: rangeTo, timezone: appConfig.timezone },
    harnesses: summaries.filter(hasHarnessData)
  };
};

export const getDay = async (harnessId: HarnessId, date: string) => {
  await ensureScanned();
  const harness = harnesses[harnessId];
  const store = stores[harnessId];
  const sessions: SessionDayTotal[] = [];
  const priorities = dailyPrioritiesFor(store);
  for (const summary of Object.values(store.files)) {
    if (!usesDailySummary(summary, date, priorities)) continue;
    sessions.push(...(summary.daily[date] ?? []));
  }
  sessions.sort((a, b) => b.totalTokens - a.totalTokens);
  const daily = buildDaily(store);
  const totals = daily.get(date) ?? null;
  const weekStart = startOfWeek(date);
  const weekToDate = [...daily.values()]
    .filter((day) => day.date >= weekStart && day.date <= date)
    .reduce(
      (acc, day) => {
        addUsage(acc, day);
        acc.events += day.events;
        return acc;
      },
      { ...emptyUsage(), weekStart, through: date, events: 0 }
    );
  return {
    harness: harness.info,
    date,
    totals,
    sessions,
    rateLimit: {
      latestForDay: latestRateLimitForDay(store, date),
      weekToDate
    }
  };
};

export const getModelUsageRange = async (from: string, to: string): Promise<ModelUsageRangeResponse> => {
  await ensureScanned();
  const byHarnessDateAndModel = new Map<string, ModelUsageRangeRow & { sessionIds: Set<string> }>();

  for (const harnessId of Object.keys(harnesses) as HarnessId[]) {
    const harness = harnesses[harnessId];
    const store = stores[harnessId];
    const priorities = dailyPrioritiesFor(store);

    for (const summary of Object.values(store.files)) {
      for (const [date, sessions] of Object.entries(summary.daily)) {
        if (date < from || date > to || !usesDailySummary(summary, date, priorities)) continue;

        for (const session of sessions) {
          const key = `${harnessId}|${date}|${session.model}|${session.estimated ? "estimated" : "logged"}`;
          let row = byHarnessDateAndModel.get(key);
          if (!row) {
            row = {
              ...emptyUsage(),
              harness: harness.info,
              date,
              model: session.model,
              events: 0,
              sessions: 0,
              sessionIds: new Set<string>(),
              ...(session.estimated && { estimated: true })
            };
            byHarnessDateAndModel.set(key, row);
          }

          addUsage(row, session);
          row.events += session.events;
          row.sessionIds.add(session.sessionId);
          row.sessions = row.sessionIds.size;
        }
      }
    }
  }

  const rows = [...byHarnessDateAndModel.values()]
    .map(({ sessionIds: _sessionIds, ...row }) => row)
    .sort((a, b) => (
      a.date.localeCompare(b.date)
      || a.harness.name.localeCompare(b.harness.name)
      || a.model.localeCompare(b.model)
    ));

  return {
    range: { from, to, timezone: appConfig.timezone },
    rows
  };
};

export const getConfig = async () => {
  await ensureScanned();
  return {
    timezone: appConfig.timezone,
    codexRoots: appConfig.codexRoots,
    copilotRoots: appConfig.copilotRoots,
    claudeRoots: appConfig.claudeRoots,
    cachePath: appConfig.cachePath,
    cacheExists: await fileExists(appConfig.cachePath),
    diagnostics: {
      codex: stores.codex.diagnostics,
      "github-copilot": stores["github-copilot"].diagnostics,
      "claude-code": stores["claude-code"].diagnostics
    }
  };
};
