import { describe, expect, it } from "vitest";
import { billableUsageParts, calculateUsageCost } from "./costMath";
import type { ModelPricing, TokenUsage } from "./types";

const usage = (overrides: Partial<TokenUsage>): TokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
  ...overrides
});

const pricing = (overrides: Partial<ModelPricing> = {}): ModelPricing => ({
  model: "test-model",
  normalizedModel: "test-model",
  provider: "openai",
  source: "catalog",
  inputUsdPerMillion: 2,
  cachedInputUsdPerMillion: 0.2,
  outputUsdPerMillion: 10,
  sourceUrl: null,
  notes: [],
  updatedAt: "2026-06-17",
  cachedAt: "2026-06-17T00:00:00.000Z",
  ...overrides
});

describe("cost math", () => {
  it("treats cached input as part of input for Codex and Copilot-style usage", () => {
    expect(billableUsageParts(usage({
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 100,
      totalTokens: 1_100
    }), "included")).toEqual({
      inputTokens: 600,
      cachedInputTokens: 400,
      outputTokens: 100
    });
  });

  it("treats cached input as separate for Claude usage", () => {
    expect(billableUsageParts(usage({
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 100,
      totalTokens: 1_500
    }), "separate")).toEqual({
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 100
    });
  });

  it("adds reasoning tokens only when they are not already included in output tokens", () => {
    expect(billableUsageParts(usage({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 3,
      reasoningOutputTokens: 1,
      totalTokens: 13
    }), "included").outputTokens).toBe(3);
    expect(billableUsageParts(usage({
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 3,
      reasoningOutputTokens: 1,
      totalTokens: 14
    }), "included").outputTokens).toBe(4);
  });

  it("calculates cost from billable token parts", () => {
    expect(calculateUsageCost(usage({
      inputTokens: 1_000_000,
      cachedInputTokens: 250_000,
      outputTokens: 100_000,
      totalTokens: 1_100_000
    }), pricing(), "included").totalCostUsd).toBe(2.55);
  });

  it("returns an incomplete total when a needed rate is missing", () => {
    expect(calculateUsageCost(usage({
      inputTokens: 10,
      outputTokens: 10,
      totalTokens: 20
    }), pricing({ outputUsdPerMillion: null }), "included").totalCostUsd).toBeNull();
  });

  it("prices cache writes from the input rate and only the remainder at the read rate", () => {
    const cost = calculateUsageCost(usage({
      inputTokens: 1_000_000,
      cachedInputTokens: 4_000_000,
      cacheWrite5mTokens: 1_000_000,
      cacheWrite1hTokens: 1_000_000,
      outputTokens: 1_000_000,
      totalTokens: 6_000_000
    }), pricing({ inputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 20 }), "separate");

    expect(cost.cachedInputCostUsd).toBeCloseTo(0.4);
    expect(cost.cacheWriteCostUsd).toBeCloseTo(13);
    expect(cost.totalCostUsd).toBeCloseTo(37.4);
  });

  it("matches a Claude Code session's own reported cost", () => {
    const cost = calculateUsageCost(usage({
      inputTokens: 528,
      cachedInputTokens: 753_225 + 129_329,
      cacheWrite1hTokens: 129_329,
      outputTokens: 15_084,
      totalTokens: 528 + 753_225 + 129_329 + 15_084
    }), pricing({ inputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 20 }), "separate");

    expect(cost.totalCostUsd).toBeCloseTo(1.489069, 6);
  });

  it("returns an incomplete total when cache writes have no input rate", () => {
    expect(calculateUsageCost(usage({
      cachedInputTokens: 10,
      cacheWrite5mTokens: 10,
      totalTokens: 10
    }), pricing({ inputUsdPerMillion: null }), "separate").totalCostUsd).toBeNull();
  });
});
