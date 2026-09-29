export type CapSettings = {
  limitUsd: number | null;
  refreshMinutes: number | null;
  resetMonth: string | null;
  resetBaselineUsd: number;
};

export const defaultCapSettings: CapSettings = {
  limitUsd: null,
  refreshMinutes: null,
  resetMonth: null,
  resetBaselineUsd: 0
};

export const readCapSettings = (): CapSettings => {
  try {
    const saved = JSON.parse(localStorage.getItem("ai-token-usage:cap-settings") ?? "null") as Partial<CapSettings> | null;
    if (!saved || typeof saved !== "object") return defaultCapSettings;
    return {
      limitUsd: typeof saved.limitUsd === "number" && Number.isFinite(saved.limitUsd) && saved.limitUsd > 0 ? saved.limitUsd : null,
      refreshMinutes: typeof saved.refreshMinutes === "number" && Number.isInteger(saved.refreshMinutes) && saved.refreshMinutes >= 1 ? saved.refreshMinutes : null,
      resetMonth: typeof saved.resetMonth === "string" && /^\d{4}-\d{2}$/.test(saved.resetMonth) ? saved.resetMonth : null,
      resetBaselineUsd: typeof saved.resetBaselineUsd === "number" && Number.isFinite(saved.resetBaselineUsd) && saved.resetBaselineUsd >= 0 ? saved.resetBaselineUsd : 0
    };
  } catch {
    return defaultCapSettings;
  }
};

export const saveCapSettings = (settings: CapSettings): void => {
  localStorage.setItem("ai-token-usage:cap-settings", JSON.stringify(settings));
};

export const dateInZone = (timezone: string, now = new Date()): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

export const capSpentUsd = (monthCostUsd: number, settings: CapSettings, month: string): number => (
  Math.max(0, monthCostUsd - (settings.resetMonth === month ? settings.resetBaselineUsd : 0))
);
