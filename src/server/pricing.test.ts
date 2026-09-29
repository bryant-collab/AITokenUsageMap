import { describe, expect, it } from "vitest";
import { getModelPricing, parseAnthropicPricing, parseGitHubCopilotPricing, parseOpenAIMarkdownPricing, parseOpenAIPricing, setManualPricing } from "./pricing";

describe("pricing lookup", () => {
  it("finds OpenAI catalog pricing by exact model", () => {
    const pricing = getModelPricing("gpt-5.4");
    expect(pricing.source).toBe("catalog");
    expect(pricing.provider).toBe("openai");
    expect(pricing.inputUsdPerMillion).toBe(2.5);
    expect(pricing.cachedInputUsdPerMillion).toBe(0.25);
    expect(pricing.outputUsdPerMillion).toBe(15);
  });

  it("finds Claude catalog pricing with dashed version aliases", () => {
    const pricing = getModelPricing("claude-sonnet-4-6-20260101");
    expect(pricing.source).toBe("catalog");
    expect(pricing.provider).toBe("anthropic");
    expect(pricing.inputUsdPerMillion).toBe(3);
    expect(pricing.cachedInputUsdPerMillion).toBe(0.3);
    expect(pricing.outputUsdPerMillion).toBe(15);
  });

  it.each([
    ["gpt-5.6", 4, 0.4, 20],
    ["gpt-5.6-sol", 4, 0.4, 20],
    ["gpt-5.6-terra", 2, 0.2, 12],
    ["gpt-5.6-luna", 0.2, 0.02, 1.2],
    ["gpt-6-astra", 10, 1, 50],
    ["gpt-6.1-sol", 2, 0.1, 10],
    ["gpt-6-luna", 0.1, 0.01, 0.5],
    ["claude-opus-5.5", 4, 0.2, 20],
    ["claude-sonnet-5", 2, 0.2, 10]
  ])("has a verified offline fallback for %s", (model, input, cached, output) => {
    const pricing = getModelPricing(model as string);
    expect(pricing.source).toBe("catalog");
    expect(pricing.inputUsdPerMillion).toBe(input);
    expect(pricing.cachedInputUsdPerMillion).toBe(cached);
    expect(pricing.outputUsdPerMillion).toBe(output);
  });

  it("parses standard OpenAI and Anthropic rates from GitHub's official table", () => {
    const markdown = `
### OpenAI
| Model | Release status | Tier | Threshold (input tokens) | Input | Cached input | Output |
| --- | --- | --- | --- | ---: | ---: | ---: |
| GPT-5.6 Terra | GA | Default | ≤ 272K | $2.50 | $0.25 | $15.00 |
| GPT-5.6 Terra | GA | Long context | > 272K | $5.00 | $0.50 | $22.50 |

### Anthropic
| Model | Release status | Input | Cached input | Cache write | Output |
| --- | --- | ---: | ---: | ---: | ---: |
| Claude Sonnet 5[^promo] | GA | $2.00 | $0.20 | $2.50 | $10.00 |
`;
    const catalog = parseGitHubCopilotPricing(markdown, "2026-07-16");

    expect(catalog.get("gpt-5.6-terra")).toMatchObject({
      provider: "openai",
      inputUsdPerMillion: 2.5,
      cachedInputUsdPerMillion: 0.25,
      outputUsdPerMillion: 15,
      updatedAt: "2026-07-16"
    });
    expect(catalog.get("gpt-5.6-terra")?.notes?.[0]).toContain("over 272K");
    expect(catalog.get("claude-sonnet-5")).toMatchObject({
      provider: "anthropic",
      inputUsdPerMillion: 2,
      cachedInputUsdPerMillion: 0.2,
      outputUsdPerMillion: 10
    });
    expect(catalog.get("claude-sonnet-5")?.notes).toHaveLength(1);
  });

  it("parses OpenAI's official standard-rate HTML table", () => {
    const html = `<div data-table="[1,[[0,&quot;gpt-5.2&quot;],[0,1.75],[0,0.175],[0,14]]]"></div><table><thead><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Cache writes</th><th>Output</th><th>Long input</th><th>Long cached</th><th>Long writes</th><th>Long output</th></tr></thead><tbody>
      <tr><td><span>gpt-5.6-sol</span></td><td>$5.00</td><td>$0.50</td><td>$6.25</td><td>$30.00</td><td>$10.00</td><td>$1.00</td><td>$12.50</td><td>$45.00</td></tr>
      <tr><td>gpt-5.4 (&lt;272K context length)</td><td>$2.50</td><td>$0.25</td><td>-</td><td>$15.00</td><td>$5.00</td><td>$0.50</td><td>-</td><td>$22.50</td></tr>
    </tbody></table>`;
    const catalog = parseOpenAIPricing(html, "2026-07-16");

    expect(catalog.get("gpt-5.6-sol")).toMatchObject({
      inputUsdPerMillion: 5,
      cachedInputUsdPerMillion: 0.5,
      outputUsdPerMillion: 30
    });
    expect(catalog.get("gpt-5.4")?.notes?.[0]).toContain("Long-context");
    expect(catalog.get("gpt-5.2")).toMatchObject({
      inputUsdPerMillion: 1.75,
      cachedInputUsdPerMillion: 0.175,
      outputUsdPerMillion: 14
    });
  });

  it("parses only OpenAI's standard Markdown tier and records excluded tiers", () => {
    const markdown = `### Standard pricing data
| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input | Long context cached input | Long context cache writes | Long context output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-astra | $10.00 | $1.00 | $12.50 | $50.00 | $20.00 | $2.00 | $25.00 | $75.00 |

### Batch pricing data
| gpt-6-astra | $5.00 | $0.50 | $6.25 | $25.00 | $10.00 | $1.00 | $12.50 | $37.50 |`;
    const catalog = parseOpenAIMarkdownPricing(markdown, "2026-09-29");
    expect(catalog.get("gpt-6-astra")).toMatchObject({ inputUsdPerMillion: 10, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 50 });
    expect(catalog.get("gpt-6-astra")?.notes).toHaveLength(2);
  });

  it("parses Anthropic's official Markdown pricing table", () => {
    const markdown = `
| Model | Base Input Tokens | 5m Cache Writes | 1h Cache Writes | Cache Hits & Refreshes | Output Tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Claude Mythos 5 ([limited availability](https://example.com)) | $10 / MTok | $12.50 / MTok | $20 / MTok | $1 / MTok | $50 / MTok |
| Claude Sonnet 5 [through August 31, 2026](https://example.com) | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok |
`;
    const catalog = parseAnthropicPricing(markdown, "2026-07-16");

    expect(catalog.get("claude-mythos-5")).toMatchObject({
      inputUsdPerMillion: 10,
      cachedInputUsdPerMillion: 1,
      outputUsdPerMillion: 50
    });
    expect(catalog.get("claude-sonnet-5")?.notes).toHaveLength(1);
  });

  it("does not invent a rate for Copilot code review's undisclosed model", () => {
    const pricing = getModelPricing("codex-auto-review");
    expect(pricing.source).toBe("missing");
    expect(pricing.sourceUrl).toContain("docs.github.com");
    expect(pricing.notes[0]).toContain("does not disclose");
  });

  it("keeps manual rates in memory for later lookups", () => {
    const manual = setManualPricing({
      model: "local-test-model",
      inputUsdPerMillion: 1.25,
      cachedInputUsdPerMillion: null,
      outputUsdPerMillion: 2.5
    });
    expect(manual.source).toBe("manual");

    const pricing = getModelPricing("local-test-model");
    expect(pricing.source).toBe("manual");
    expect(pricing.inputUsdPerMillion).toBe(1.25);
    expect(pricing.cachedInputUsdPerMillion).toBeNull();
    expect(pricing.outputUsdPerMillion).toBe(2.5);
  });
});
