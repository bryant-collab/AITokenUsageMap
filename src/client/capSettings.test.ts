import { describe, expect, it } from "vitest";
import { capSpentUsd, dateInZone, defaultCapSettings } from "./capSettings";

describe("monthly cost cap", () => {
  it("uses the selected timezone for the month boundary", () => {
    expect(dateInZone("America/Denver", new Date("2026-10-01T00:30:00Z"))).toBe("2026-09-30");
  });

  it("subtracts a manual reset only in the same month", () => {
    const settings = { ...defaultCapSettings, limitUsd: 10, resetMonth: "2026-09", resetBaselineUsd: 7 };
    expect(capSpentUsd(9, settings, "2026-09")).toBe(2);
    expect(capSpentUsd(1, settings, "2026-10")).toBe(1);
    expect(capSpentUsd(5, settings, "2026-09")).toBe(0);
  });
});
