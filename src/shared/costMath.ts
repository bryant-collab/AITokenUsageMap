import type { HarnessId, ModelPricing, TokenUsage } from "./types";

export type CachedInputMode = "included" | "separate";

// Anthropic prices cache writes as a multiple of the model's base input rate.
const CACHE_WRITE_5M_INPUT_MULTIPLIER = 1.25;
const CACHE_WRITE_1H_INPUT_MULTIPLIER = 2;

export type BillableUsageParts = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
};

export type UsageCostBreakdown = BillableUsageParts & {
  inputCostUsd: number | null;
  cachedInputCostUsd: number | null;
  cacheWriteCostUsd: number | null;
  outputCostUsd: number | null;
  totalCostUsd: number | null;
};

export const cachedInputModeForHarness = (harness: HarnessId): CachedInputMode => (
  harness === "claude-code" ? "separate" : "included"
);

export const billableUsageParts = (usage: TokenUsage, cachedInputMode: CachedInputMode): BillableUsageParts => {
  const cachedInputTokens = Math.max(
    0,
    cachedInputMode === "included"
      ? Math.min(usage.cachedInputTokens, usage.inputTokens)
      : usage.cachedInputTokens
  );
  const inputTokens = cachedInputMode === "included"
    ? Math.max(0, usage.inputTokens - cachedInputTokens)
    : Math.max(0, usage.inputTokens);
  const outputAndReasoningTokens = Math.max(0, usage.outputTokens + usage.reasoningOutputTokens);
  const cachedAdjustedInput = cachedInputMode === "separate"
    ? inputTokens + cachedInputTokens
    : inputTokens + cachedInputTokens;
  const outputTokens = usage.reasoningOutputTokens > 0 && cachedAdjustedInput + outputAndReasoningTokens <= usage.totalTokens
    ? outputAndReasoningTokens
    : Math.max(0, usage.outputTokens);

  return {
    inputTokens,
    cachedInputTokens,
    outputTokens
  };
};

const costFor = (tokens: number, usdPerMillion: number | null): number | null => {
  if (tokens <= 0) return 0;
  if (usdPerMillion === null || !Number.isFinite(usdPerMillion)) return null;
  return (tokens * usdPerMillion) / 1_000_000;
};

const sumCosts = (...costs: Array<number | null>): number | null => {
  if (costs.some((cost) => cost === null)) return null;
  return costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
};

export const calculateUsageCost = (
  usage: TokenUsage,
  pricing: ModelPricing,
  cachedInputMode: CachedInputMode
): UsageCostBreakdown => {
  const parts = billableUsageParts(usage, cachedInputMode);
  const cachedRate = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
  const inputCostUsd = costFor(parts.inputTokens, pricing.inputUsdPerMillion);
  const write5mTokens = usage.cacheWrite5mTokens ?? 0;
  const write1hTokens = usage.cacheWrite1hTokens ?? 0;
  const cacheReadTokens = Math.max(0, parts.cachedInputTokens - write5mTokens - write1hTokens);
  const writeRate = (multiplier: number): number | null => (
    pricing.inputUsdPerMillion === null ? null : pricing.inputUsdPerMillion * multiplier
  );
  const cachedInputCostUsd = costFor(cacheReadTokens, cachedRate);
  const cacheWriteCostUsd = sumCosts(
    costFor(write5mTokens, writeRate(CACHE_WRITE_5M_INPUT_MULTIPLIER)),
    costFor(write1hTokens, writeRate(CACHE_WRITE_1H_INPUT_MULTIPLIER))
  );
  const outputCostUsd = costFor(parts.outputTokens, pricing.outputUsdPerMillion);

  return {
    ...parts,
    inputCostUsd,
    cachedInputCostUsd,
    cacheWriteCostUsd,
    outputCostUsd,
    totalCostUsd: sumCosts(inputCostUsd, cachedInputCostUsd, cacheWriteCostUsd, outputCostUsd)
  };
};
