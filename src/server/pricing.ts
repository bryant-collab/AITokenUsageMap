import type { ModelPricing, ModelPricingProvider, ModelPricingUpdate, PricingResponse } from "../shared/types";

const FALLBACK_CATALOG_UPDATED_AT = "2026-09-29";
const OPENAI_PRICING_URL = "https://developers.openai.com/api/docs/pricing";
const OPENAI_PRICING_MARKDOWN_URL = `${OPENAI_PRICING_URL}.md`;
const ANTHROPIC_PRICING_URL = "https://platform.claude.com/docs/en/about-claude/pricing";
const GITHUB_COPILOT_PRICING_URL = "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing";
const GITHUB_COPILOT_PRICING_MARKDOWN_URL = "https://docs.github.com/api/article/body?pathname=/en/copilot/reference/copilot-billing/models-and-pricing";
const OFFICIAL_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const FAILED_REFRESH_TTL_MS = 15 * 60 * 1000;

type CatalogEntry = {
  provider: Exclude<ModelPricingProvider, "unknown">;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number | null;
  outputUsdPerMillion: number;
  sourceUrl: string;
  notes?: string[];
  updatedAt?: string;
};

const fallbackCatalog = new Map<string, CatalogEntry>([
  ["gpt-5-mini", { provider: "openai", inputUsdPerMillion: 0.25, cachedInputUsdPerMillion: 0.025, outputUsdPerMillion: 2, sourceUrl: OPENAI_PRICING_URL }],
  ["gpt-5.3-codex", { provider: "openai", inputUsdPerMillion: 1.75, cachedInputUsdPerMillion: 0.175, outputUsdPerMillion: 14, sourceUrl: OPENAI_PRICING_URL }],
  ["gpt-5.4", { provider: "openai", inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15, sourceUrl: OPENAI_PRICING_URL, notes: ["Requests over 272K input tokens use long-context rates; this estimate uses the default tier."] }],
  ["gpt-5.4-mini", { provider: "openai", inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5, sourceUrl: OPENAI_PRICING_URL }],
  ["gpt-5.4-nano", { provider: "openai", inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.25, sourceUrl: OPENAI_PRICING_URL }],
  ["gpt-5.5", { provider: "openai", inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30, sourceUrl: OPENAI_PRICING_URL, notes: ["Requests over 272K input tokens use long-context rates; this estimate uses the default tier."] }],
  ["gpt-5.6-sol", { provider: "openai", inputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.4, outputUsdPerMillion: 20, sourceUrl: OPENAI_PRICING_URL, notes: ["Long-context requests have higher rates; this estimate uses the default tier."] }],
  ["gpt-5.6-terra", { provider: "openai", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 12, sourceUrl: OPENAI_PRICING_URL, notes: ["Long-context requests have higher rates; this estimate uses the default tier."] }],
  ["gpt-5.6-luna", { provider: "openai", inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.2, sourceUrl: OPENAI_PRICING_URL, notes: ["Long-context requests have higher rates; this estimate uses the default tier."] }],
  ["gpt-6-astra", { provider: "openai", inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 50, sourceUrl: OPENAI_PRICING_URL, notes: ["Long-context requests have higher rates; this estimate uses the default tier."] }],
  ["gpt-6.1-sol", { provider: "openai", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 10, sourceUrl: OPENAI_PRICING_URL, notes: ["Long-context requests have higher rates; this estimate uses the default tier."] }],
  ["gpt-6-sol", { provider: "openai", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 10, sourceUrl: OPENAI_PRICING_URL, notes: ["Long-context requests have higher rates; this estimate uses the default tier."] }],
  ["gpt-6-luna", { provider: "openai", inputUsdPerMillion: 0.1, cachedInputUsdPerMillion: 0.01, outputUsdPerMillion: 0.5, sourceUrl: OPENAI_PRICING_URL, notes: ["Long-context requests have higher rates; this estimate uses the default tier."] }],
  ["chat-latest", { provider: "openai", inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30, sourceUrl: OPENAI_PRICING_URL }],
  ["claude-fable-5", { provider: "anthropic", inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 50, sourceUrl: ANTHROPIC_PRICING_URL }],
  ["claude-fable-5.1", { provider: "anthropic", inputUsdPerMillion: 10, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 50, sourceUrl: ANTHROPIC_PRICING_URL }],
  ["claude-mythos-5", { provider: "anthropic", inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 50, sourceUrl: ANTHROPIC_PRICING_URL, notes: ["Limited availability model."] }],
  ["claude-mythos-5.1", { provider: "anthropic", inputUsdPerMillion: 10, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 50, sourceUrl: ANTHROPIC_PRICING_URL, notes: ["Limited availability model."] }],
  ["claude-opus-5.5", { provider: "anthropic", inputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 20, sourceUrl: ANTHROPIC_PRICING_URL }],
  ["claude-opus-5", { provider: "anthropic", inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 25, sourceUrl: ANTHROPIC_PRICING_URL }],
  ["claude-opus-4.8", { provider: "anthropic", inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 25, sourceUrl: ANTHROPIC_PRICING_URL }],
  ["claude-opus-4.7", { provider: "anthropic", inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 25, sourceUrl: ANTHROPIC_PRICING_URL }],
  ["claude-opus-4.6", { provider: "anthropic", inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 25, sourceUrl: ANTHROPIC_PRICING_URL }],
  ["claude-opus-4.5", { provider: "anthropic", inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 25, sourceUrl: ANTHROPIC_PRICING_URL }],
  ["claude-opus-4.1", { provider: "anthropic", inputUsdPerMillion: 15, cachedInputUsdPerMillion: 1.5, outputUsdPerMillion: 75, sourceUrl: ANTHROPIC_PRICING_URL, notes: ["Deprecated model pricing."] }],
  ["claude-opus-4", { provider: "anthropic", inputUsdPerMillion: 15, cachedInputUsdPerMillion: 1.5, outputUsdPerMillion: 75, sourceUrl: ANTHROPIC_PRICING_URL, notes: ["Retired model pricing except on selected partner platforms."] }],
  ["claude-sonnet-5.5", { provider: "anthropic", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 10, sourceUrl: ANTHROPIC_PRICING_URL }],
  ["claude-sonnet-5", { provider: "anthropic", inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.2, outputUsdPerMillion: 10, sourceUrl: ANTHROPIC_PRICING_URL }],
  ["claude-sonnet-4.6", { provider: "anthropic", inputUsdPerMillion: 3, cachedInputUsdPerMillion: 0.3, outputUsdPerMillion: 15, sourceUrl: ANTHROPIC_PRICING_URL }],
  ["claude-sonnet-4.5", { provider: "anthropic", inputUsdPerMillion: 3, cachedInputUsdPerMillion: 0.3, outputUsdPerMillion: 15, sourceUrl: ANTHROPIC_PRICING_URL }],
  ["claude-sonnet-4", { provider: "anthropic", inputUsdPerMillion: 3, cachedInputUsdPerMillion: 0.3, outputUsdPerMillion: 15, sourceUrl: ANTHROPIC_PRICING_URL, notes: ["Retired model pricing except on selected partner platforms."] }],
  ["claude-haiku-4.5", { provider: "anthropic", inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 5, sourceUrl: ANTHROPIC_PRICING_URL }],
  ["claude-haiku-3.5", { provider: "anthropic", inputUsdPerMillion: 0.8, cachedInputUsdPerMillion: 0.08, outputUsdPerMillion: 4, sourceUrl: ANTHROPIC_PRICING_URL, notes: ["Retired model pricing except on selected partner platforms."] }]
]);

const manualPricing = new Map<string, ModelPricing>();
const lookupCache = new Map<string, ModelPricing>();
let activeCatalog = new Map(fallbackCatalog);
let refreshAfter = 0;
let refreshInFlight: Promise<void> | null = null;

export const normalizePricingModel = (model: string): string => (
  model
    .trim()
    .toLowerCase()
    .replace(/^models\//, "")
    .replace(/_/g, "-")
    .replace(/\s+/g, "-")
    .replace(/--+/g, "-")
);

const withoutDateSuffix = (normalized: string): string => (
  normalized
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "")
);

const decimalClaudeVersion = (normalized: string): string => (
  normalized
    .replace(/claude-(fable|mythos|opus|sonnet|haiku)-(\d)-(\d)(?=$|-)/, "claude-$1-$2.$3")
    .replace(/claude-(\d)-(\d)-(opus|sonnet|haiku)/, "claude-$3-$1.$2")
    .replace(/claude-(\d)-(opus|sonnet|haiku)/, "claude-$2-$1")
);

const catalogKeyFor = (normalized: string): string => {
  const providerAlias = normalized === "gpt-5.6" ? "gpt-5.6-sol" : normalized;
  const candidates = [
    providerAlias,
    decimalClaudeVersion(providerAlias),
    withoutDateSuffix(providerAlias),
    decimalClaudeVersion(withoutDateSuffix(providerAlias))
  ];
  for (const candidate of candidates) {
    if (activeCatalog.has(candidate)) return candidate;
  }
  return normalized;
};

const priceFromCell = (value: string | undefined): number | null => {
  const match = value?.replace(/,/g, "").match(/\$?([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : null;
};

const markdownCells = (line: string): string[] => (
  line.trim().slice(1, -1).split("|").map((cell) => cell.trim())
);

const cleanMarkdownModel = (value: string): string => (
  value
    .replace(/\[\^[^\]]+\]/g, "")
    .replace(/[*_`]/g, "")
    .trim()
);

const isSeparatorRow = (cells: string[]): boolean => (
  cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell))
);

export const parseGitHubCopilotPricing = (markdown: string, checkedAt: string): Map<string, CatalogEntry> => {
  const catalog = new Map<string, CatalogEntry>();
  let provider: CatalogEntry["provider"] | null = null;
  let headers: string[] | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      const name = heading[1].trim().toLowerCase();
      provider = name === "openai" || name === "anthropic" ? name : null;
      headers = null;
      continue;
    }
    if (!provider || !line.trim().startsWith("|") || !line.trim().endsWith("|")) continue;

    const cells = markdownCells(line);
    if (isSeparatorRow(cells) || cells.every((cell) => !cell)) continue;
    if (cells[0].toLowerCase() === "model") {
      headers = cells.map((cell) => cell.toLowerCase());
      continue;
    }
    if (!headers) continue;

    const cell = (name: string): string | undefined => {
      const index = headers?.indexOf(name) ?? -1;
      return index >= 0 ? cells[index] : undefined;
    };
    const displayModel = cleanMarkdownModel(cell("model") ?? "");
    const input = priceFromCell(cell("input"));
    const cached = priceFromCell(cell("cached input"));
    const output = priceFromCell(cell("output"));
    if (!displayModel || input === null || output === null) continue;

    const key = normalizePricingModel(displayModel);
    const tier = cell("tier")?.toLowerCase();
    if (tier === "long context") {
      const existing = catalog.get(key);
      if (existing) {
        const threshold = cell("threshold (input tokens)")?.replace(/^>\s*/, "over ");
        existing.notes = [`Requests ${threshold ?? "in the long-context tier"} use higher rates; this estimate uses the default tier.`];
      }
      continue;
    }

    const notes: string[] = [];
    if (cell("cache write")) notes.push("Cache writes have a separate rate; cached tokens here use the cache-read rate.");
    catalog.set(key, {
      provider,
      inputUsdPerMillion: input,
      cachedInputUsdPerMillion: cached,
      outputUsdPerMillion: output,
      sourceUrl: GITHUB_COPILOT_PRICING_URL,
      notes,
      updatedAt: checkedAt
    });
  }

  return catalog;
};

const textFromHtml = (value: string): string => (
  value
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
);

export const parseOpenAIPricing = (html: string, checkedAt: string): Map<string, CatalogEntry> => {
  const catalog = new Map<string, CatalogEntry>();
  const tables = html.match(/<table\b[\s\S]*?<\/table>/gi) ?? [];
  const standardTable = tables.find((table) => /<td\b[^>]*>[\s\S]*?gpt-/i.test(table) && /Cached input/i.test(table));

  for (const row of standardTable?.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => textFromHtml(match[1]));
    if (cells.length < 4) continue;
    const modelMatch = cells[0].match(/^((?:gpt|chatgpt|o\d|codex)[a-z0-9.-]*(?:-[a-z0-9.-]+)*)/i);
    if (!modelMatch) continue;
    const input = priceFromCell(cells[1]);
    const cached = priceFromCell(cells[2]);
    const output = priceFromCell(cells.length >= 5 ? cells[4] : cells[3]);
    if (input === null || output === null) continue;

    const notes = /context length/i.test(cells[0])
      ? ["Long-context requests use higher rates; this estimate uses the standard tier."]
      : [];
    catalog.set(normalizePricingModel(modelMatch[1]), {
      provider: "openai",
      inputUsdPerMillion: input,
      cachedInputUsdPerMillion: cached,
      outputUsdPerMillion: output,
      sourceUrl: OPENAI_PRICING_URL,
      notes,
      updatedAt: checkedAt
    });
  }

  // The page renders only part of the catalog into HTML, but embeds every row in its
  // serialized table data. First occurrence wins because standard pricing precedes
  // batch, flex, and priority tables on the official page.
  const serializedRow = /\[1,\[\[0,&quot;([^&]+)&quot;\],((?:\[0,(?:-?\d+(?:\.\d+)?|&quot;[^&]*&quot;)\],?){3,8})\]\]/g;
  for (const match of html.matchAll(serializedRow)) {
    const rawModel = textFromHtml(match[1]);
    const modelMatch = rawModel.match(/^((?:gpt|chatgpt|o\d|codex)[a-z0-9.-]*(?:-[a-z0-9.-]+)*)/i);
    if (!modelMatch) continue;
    const key = normalizePricingModel(modelMatch[1]);
    if (catalog.has(key)) continue;

    const values = [...match[2].matchAll(/\[0,(?:&quot;([^&]*)&quot;|(-?\d+(?:\.\d+)?))\]/g)]
      .map((value) => value[1] ?? value[2]);
    const input = priceFromCell(values[0]);
    const cached = priceFromCell(values[1]);
    const output = priceFromCell(values.length === 3 ? values[2] : values[3]);
    if (input === null || output === null) continue;

    catalog.set(key, {
      provider: "openai",
      inputUsdPerMillion: input,
      cachedInputUsdPerMillion: cached,
      outputUsdPerMillion: output,
      sourceUrl: OPENAI_PRICING_URL,
      notes: /context length/i.test(rawModel) ? ["Long-context requests use higher rates; this estimate uses the standard tier."] : [],
      updatedAt: checkedAt
    });
  }

  return catalog;
};

export const parseOpenAIMarkdownPricing = (markdown: string, checkedAt: string): Map<string, CatalogEntry> => {
  const catalog = new Map<string, CatalogEntry>();
  const standard = markdown.match(/### Standard pricing data\s*\n([\s\S]*?)(?=\n\s*### |\n\s*Batch\s*\n|$)/i)?.[1] ?? "";
  for (const line of standard.split(/\r?\n/)) {
    if (!line.trim().startsWith("|") || !line.trim().endsWith("|")) continue;
    const cells = markdownCells(line);
    if (cells.length < 5 || cells[0] === "Model" || isSeparatorRow(cells)) continue;
    const rawModel = cells[0];
    const match = rawModel.match(/^((?:gpt|chatgpt|o\d|codex)[a-z0-9.-]*(?:-[a-z0-9.-]+)*)/i);
    if (!match) continue;
    const input = priceFromCell(cells[1]);
    const cached = priceFromCell(cells[2]);
    const output = priceFromCell(cells[4]);
    if (input === null || output === null) continue;
    const notes: string[] = [];
    if (priceFromCell(cells[5]) !== null) notes.push("Long-context requests have higher rates; this estimate uses the default tier.");
    if (priceFromCell(cells[3]) !== null) notes.push("Cache writes have a separate rate that is not included in this estimate.");
    catalog.set(normalizePricingModel(match[1]), {
      provider: "openai",
      inputUsdPerMillion: input,
      cachedInputUsdPerMillion: cached,
      outputUsdPerMillion: output,
      sourceUrl: OPENAI_PRICING_URL,
      notes,
      updatedAt: checkedAt
    });
  }
  return catalog;
};

export const parseAnthropicPricing = (markdown: string, checkedAt: string): Map<string, CatalogEntry> => {
  const catalog = new Map<string, CatalogEntry>();
  let headers: string[] | null = null;

  for (const line of markdown.split(/\r?\n/)) {
    if (!line.trim().startsWith("|") || !line.trim().endsWith("|")) {
      headers = null;
      continue;
    }
    const cells = markdownCells(line);
    if (isSeparatorRow(cells) || cells.every((cell) => !cell)) continue;
    if (cells[0].toLowerCase() === "model" && cells.some((cell) => cell.toLowerCase() === "base input tokens")) {
      headers = cells.map((cell) => cell.toLowerCase());
      continue;
    }
    if (!headers) continue;

    const cell = (name: string): string | undefined => {
      const index = headers?.indexOf(name) ?? -1;
      return index >= 0 ? cells[index] : undefined;
    };
    const modelMatch = (cell("model") ?? "").match(/^(Claude\s+(?:Fable|Mythos|Opus|Sonnet|Haiku)\s+\d+(?:\.\d+)?)/i);
    const input = priceFromCell(cell("base input tokens"));
    const cached = priceFromCell(cell("cache hits & refreshes") ?? cell("cache hits and refreshes"));
    const output = priceFromCell(cell("output tokens"));
    if (!modelMatch || input === null || output === null) continue;

    const displayModel = modelMatch[1];
    const notes = ["Cache writes have a separate rate; cached tokens here use the cache-read rate."];
    catalog.set(normalizePricingModel(displayModel), {
      provider: "anthropic",
      inputUsdPerMillion: input,
      cachedInputUsdPerMillion: cached,
      outputUsdPerMillion: output,
      sourceUrl: ANTHROPIC_PRICING_URL,
      notes,
      updatedAt: checkedAt
    });
  }

  return catalog;
};

const fetchOfficialText = async (url: string, accept: string): Promise<string> => {
  const response = await fetch(url, { headers: { accept }, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
};

const refreshOfficialCatalog = async (): Promise<void> => {
  if (Date.now() < refreshAfter) return;
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const results = await Promise.allSettled([
      fetchOfficialText(OPENAI_PRICING_MARKDOWN_URL, "text/markdown"),
      fetchOfficialText(ANTHROPIC_PRICING_URL, "text/markdown"),
      fetchOfficialText(GITHUB_COPILOT_PRICING_MARKDOWN_URL, "text/markdown")
    ]);
    try {
      const checkedAt = new Date().toISOString().slice(0, 10);
      const openai = results[0].status === "fulfilled" ? parseOpenAIMarkdownPricing(results[0].value, checkedAt) : new Map<string, CatalogEntry>();
      const anthropic = results[1].status === "fulfilled" ? parseAnthropicPricing(results[1].value, checkedAt) : new Map<string, CatalogEntry>();
      const copilot = results[2].status === "fulfilled" ? parseGitHubCopilotPricing(results[2].value, checkedAt) : new Map<string, CatalogEntry>();
      if (openai.size + anthropic.size + copilot.size === 0) throw new Error("Official pricing sources contained no recognized rates");
      // Provider pricing is authoritative for API usage; Copilot fills models absent from those catalogs.
      activeCatalog = new Map([...fallbackCatalog, ...copilot, ...openai, ...anthropic]);
      lookupCache.clear();
      refreshAfter = Date.now() + OFFICIAL_CATALOG_TTL_MS;
    } catch {
      refreshAfter = Date.now() + FAILED_REFRESH_TTL_MS;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
};

const modelPricingFromCatalog = (model: string, normalizedModel: string, entry: CatalogEntry): ModelPricing => ({
  model,
  normalizedModel,
  provider: entry.provider,
  source: "catalog",
  inputUsdPerMillion: entry.inputUsdPerMillion,
  cachedInputUsdPerMillion: entry.cachedInputUsdPerMillion,
  outputUsdPerMillion: entry.outputUsdPerMillion,
  sourceUrl: entry.sourceUrl,
  notes: entry.notes ?? [],
  updatedAt: entry.updatedAt ?? FALLBACK_CATALOG_UPDATED_AT,
  cachedAt: new Date().toISOString()
});

const missingPricing = (model: string, normalizedModel: string): ModelPricing => {
  const isCopilotCodeReview = normalizedModel === "codex-auto-review";
  return {
    model,
    normalizedModel,
    provider: normalizedModel.includes("claude") ? "anthropic" : normalizedModel.startsWith("gpt-") || normalizedModel.startsWith("o") ? "openai" : "unknown",
    source: "missing",
    inputUsdPerMillion: null,
    cachedInputUsdPerMillion: null,
    outputUsdPerMillion: null,
    sourceUrl: isCopilotCodeReview ? GITHUB_COPILOT_PRICING_URL : null,
    notes: [isCopilotCodeReview
      ? "GitHub does not disclose the model selected for Copilot code review, so an official per-token rate cannot be assigned."
      : "No matching official rate was found. Enter rates to estimate this model for the current application session."],
    updatedAt: null,
    cachedAt: new Date().toISOString()
  };
};

export const getModelPricing = (model: string): ModelPricing => {
  const normalizedModel = normalizePricingModel(model);
  const manual = manualPricing.get(normalizedModel);
  if (manual) return { ...manual, model };

  const cached = lookupCache.get(normalizedModel);
  if (cached) return { ...cached, model };

  const catalogKey = catalogKeyFor(normalizedModel);
  const catalogEntry = activeCatalog.get(catalogKey);
  const pricing = catalogEntry
    ? modelPricingFromCatalog(model, normalizedModel, catalogEntry)
    : missingPricing(model, normalizedModel);
  lookupCache.set(normalizedModel, pricing);
  return pricing;
};

export const getPricingForModels = async (models: string[]): Promise<PricingResponse> => {
  await refreshOfficialCatalog();
  const seen = new Set<string>();
  const rates: ModelPricing[] = [];
  for (const model of models.map((item) => item.trim()).filter(Boolean)) {
    const normalizedModel = normalizePricingModel(model);
    if (seen.has(normalizedModel)) continue;
    seen.add(normalizedModel);
    rates.push(getModelPricing(model));
  }
  return { rates };
};

const finiteRate = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value)) && Number(value) >= 0) return Number(value);
  return null;
};

export const setManualPricing = (update: ModelPricingUpdate): ModelPricing => {
  const normalizedModel = normalizePricingModel(update.model);
  const inputUsdPerMillion = finiteRate(update.inputUsdPerMillion);
  const cachedInputUsdPerMillion = update.cachedInputUsdPerMillion === null ? null : finiteRate(update.cachedInputUsdPerMillion);
  const outputUsdPerMillion = finiteRate(update.outputUsdPerMillion);

  if (!normalizedModel || inputUsdPerMillion === null || outputUsdPerMillion === null) {
    throw new Error("Model, input price, and output price are required.");
  }

  const existing = getModelPricing(update.model);
  const pricing: ModelPricing = {
    model: update.model,
    normalizedModel,
    provider: existing.provider,
    source: "manual",
    inputUsdPerMillion,
    cachedInputUsdPerMillion,
    outputUsdPerMillion,
    sourceUrl: null,
    notes: ["Manual rate stored in memory for this application session."],
    updatedAt: new Date().toISOString(),
    cachedAt: new Date().toISOString()
  };
  manualPricing.set(normalizedModel, pricing);
  lookupCache.set(normalizedModel, pricing);
  return pricing;
};
