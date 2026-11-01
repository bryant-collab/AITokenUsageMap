import type { TokenUsage } from "./types";

export const emptyUsage = (): TokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0
});

export const addUsage = <T extends TokenUsage>(target: T, usage: TokenUsage): T => {
  target.inputTokens += usage.inputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.outputTokens += usage.outputTokens;
  target.reasoningOutputTokens += usage.reasoningOutputTokens;
  target.totalTokens += usage.totalTokens;
  if (usage.cacheWrite5mTokens) target.cacheWrite5mTokens = (target.cacheWrite5mTokens ?? 0) + usage.cacheWrite5mTokens;
  if (usage.cacheWrite1hTokens) target.cacheWrite1hTokens = (target.cacheWrite1hTokens ?? 0) + usage.cacheWrite1hTokens;
  return target;
};

export const subtractUsage = (current: TokenUsage, previous: TokenUsage): TokenUsage => ({
  inputTokens: Math.max(0, current.inputTokens - previous.inputTokens),
  cachedInputTokens: Math.max(0, current.cachedInputTokens - previous.cachedInputTokens),
  outputTokens: Math.max(0, current.outputTokens - previous.outputTokens),
  reasoningOutputTokens: Math.max(0, current.reasoningOutputTokens - previous.reasoningOutputTokens),
  totalTokens: Math.max(0, current.totalTokens - previous.totalTokens)
});
