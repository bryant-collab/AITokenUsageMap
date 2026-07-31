import type {
  DashboardResponse,
  DayResponse,
  HarnessId,
  ModelPricing,
  ModelPricingUpdate,
  ModelUsageRangeResponse,
  PricingResponse
} from "./types";

export type DesktopApi = {
  getSummary: () => Promise<DashboardResponse>;
  getDay: (harness: HarnessId, date: string) => Promise<DayResponse>;
  getModelUsage: (from: string, to: string) => Promise<ModelUsageRangeResponse>;
  getPricing: (models: string[]) => Promise<PricingResponse>;
  savePricing: (update: ModelPricingUpdate) => Promise<ModelPricing>;
  rescan: () => Promise<void>;
};

export const desktopChannels = {
  getSummary: "desktop:get-summary",
  getDay: "desktop:get-day",
  getModelUsage: "desktop:get-model-usage",
  getPricing: "desktop:get-pricing",
  savePricing: "desktop:save-pricing",
  rescan: "desktop:rescan"
} as const;
