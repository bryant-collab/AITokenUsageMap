import type { HarnessId, ModelPricingUpdate } from "../shared/types";

const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;
const harnessIds = new Set<HarnessId>(["codex", "github-copilot", "claude-code"]);

export const assertIsoDate = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !isoDatePattern.test(value)) {
    throw new Error(`${label} must be a YYYY-MM-DD date.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} must be a valid date.`);
  }
  return value;
};

export const assertDateRange = (fromValue: unknown, toValue: unknown): { from: string; to: string } => {
  const from = assertIsoDate(fromValue, "from");
  const to = assertIsoDate(toValue, "to");
  if (to < from) throw new Error("to must be on or after from.");
  return { from, to };
};

export const assertHarnessId = (value: unknown): HarnessId => {
  if (typeof value !== "string" || !harnessIds.has(value as HarnessId)) {
    throw new Error("Unknown provider.");
  }
  return value as HarnessId;
};

export const assertModels = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 250) throw new Error("Invalid model list.");
  const models = value.map((model) => {
    if (typeof model !== "string" || model.length > 500) throw new Error("Invalid model name.");
    return model.trim();
  }).filter(Boolean);
  return [...new Set(models)];
};

export const assertPricingUpdate = (value: unknown): ModelPricingUpdate => {
  if (!value || typeof value !== "object") throw new Error("Invalid pricing update.");
  const update = value as Partial<ModelPricingUpdate>;
  if (typeof update.model !== "string" || !update.model.trim() || update.model.length > 500) {
    throw new Error("A valid model name is required.");
  }
  const validRate = (rate: unknown): rate is number => (
    typeof rate === "number" && Number.isFinite(rate) && rate >= 0
  );
  if (!validRate(update.inputUsdPerMillion) || !validRate(update.outputUsdPerMillion)) {
    throw new Error("Input and output prices must be non-negative numbers.");
  }
  if (update.cachedInputUsdPerMillion !== null && !validRate(update.cachedInputUsdPerMillion)) {
    throw new Error("Cached input price must be null or a non-negative number.");
  }
  return {
    model: update.model.trim(),
    inputUsdPerMillion: update.inputUsdPerMillion,
    cachedInputUsdPerMillion: update.cachedInputUsdPerMillion,
    outputUsdPerMillion: update.outputUsdPerMillion
  };
};
