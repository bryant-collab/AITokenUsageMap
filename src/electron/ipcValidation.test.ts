import { describe, expect, it } from "vitest";
import { assertDateRange, assertHarnessId, assertIsoDate, assertModels, assertPricingUpdate } from "./ipcValidation";

describe("desktop IPC validation", () => {
  it("accepts supported providers and real ISO dates", () => {
    expect(assertHarnessId("claude-code")).toBe("claude-code");
    expect(assertIsoDate("2026-07-31", "date")).toBe("2026-07-31");
    expect(assertDateRange("2026-07-01", "2026-07-31")).toEqual({ from: "2026-07-01", to: "2026-07-31" });
  });

  it("rejects malformed providers and date ranges", () => {
    expect(() => assertHarnessId("other")).toThrow("Unknown provider");
    expect(() => assertIsoDate("2026-02-30", "date")).toThrow("valid date");
    expect(() => assertDateRange("2026-08-01", "2026-07-31")).toThrow("on or after");
  });

  it("deduplicates model names and validates manual rates", () => {
    expect(assertModels([" gpt-5 ", "gpt-5"])).toEqual(["gpt-5"]);
    expect(assertPricingUpdate({
      model: "gpt-5",
      inputUsdPerMillion: 1,
      cachedInputUsdPerMillion: null,
      outputUsdPerMillion: 2
    }).model).toBe("gpt-5");
    expect(() => assertPricingUpdate({ model: "gpt-5", inputUsdPerMillion: -1, outputUsdPerMillion: 2 })).toThrow();
  });
});
