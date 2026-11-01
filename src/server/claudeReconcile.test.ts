import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeUsageFile } from "./claudeParser";
import { estimateClaudeUnloggedUsage } from "./claudeReconcile";
import type { ParsedFileSummary } from "./parser";

const assistant = (id: string, model: string, usage: Record<string, unknown>, timestamp = "2026-06-01T12:00:00.000Z") => ({
  type: "assistant",
  requestId: id,
  sessionId: "session-1",
  timestamp,
  message: { model, usage }
});

const costState = (modelUsage: Record<string, Record<string, number>>, sessionId = "session-1") => ({
  type: "cost-state",
  sessionId,
  modelUsage
});

const opusUsage = {
  input_tokens: 2,
  output_tokens: 100,
  cache_read_input_tokens: 1_000,
  cache_creation_input_tokens: 50,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 50 }
};

const reportedOpus = (overrides: Record<string, number> = {}) => ({
  inputTokens: 2,
  outputTokens: 100,
  cacheReadInputTokens: 1_000,
  cacheCreationInputTokens: 50,
  cacheCreationEphemeral5mInputTokens: 0,
  cacheCreationEphemeral1hInputTokens: 50,
  ...overrides
});

const parseSession = async (files: Record<string, unknown[]>): Promise<Record<string, ParsedFileSummary>> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "claude-reconcile-"));
  const summaries: Record<string, ParsedFileSummary> = {};
  for (const [relative, records] of Object.entries(files)) {
    const file = path.join(dir, "projects", "repo", relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, records.map((record) => JSON.stringify(record)).join("\n"), "utf8");
    summaries[file] = await parseClaudeUsageFile(file, "UTC");
  }
  return summaries;
};

const estimatedRows = (estimates: Record<string, ParsedFileSummary>) => (
  Object.values(estimates).flatMap((summary) => Object.values(summary.daily).flat())
);

describe("estimateClaudeUnloggedUsage", () => {
  it("adds only the usage missing from logged requests, per model and token type", async () => {
    const estimates = estimateClaudeUnloggedUsage(await parseSession({
      "session-1.jsonl": [
        assistant("req-1", "claude-opus-5-5", opusUsage),
        costState({
          "claude-opus-5-5": reportedOpus({
            inputTokens: 508,
            outputTokens: 108,
            cacheReadInputTokens: 2_050,
            cacheCreationInputTokens: 150,
            cacheCreationEphemeral1hInputTokens: 150
          }),
          "claude-haiku-5-5": { inputTokens: 1_188, outputTokens: 16, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
        })
      ]
    }));

    const rows = estimatedRows(estimates);
    expect(rows.find((row) => row.model === "claude-opus-5-5")).toMatchObject({
      inputTokens: 506,
      cachedInputTokens: 1_150,
      cacheWrite1hTokens: 100,
      outputTokens: 8,
      totalTokens: 1_664,
      events: 0,
      estimated: true
    });
    expect(rows.find((row) => row.model === "claude-haiku-5-5")).toMatchObject({ inputTokens: 1_188, outputTokens: 16, totalTokens: 1_204 });
    const [summary] = Object.values(estimates);
    expect(summary.dailySessionCounts?.["2026-06-01"]).toBe(0);
    expect(summary.tokenEvents).toBe(0);
    expect(summary.events).toEqual([]);
  });

  it("counts subagent transcripts before comparing with the session total", async () => {
    const estimates = estimateClaudeUnloggedUsage(await parseSession({
      "session-1.jsonl": [
        assistant("req-1", "claude-opus-5-5", opusUsage),
        costState({
          "claude-opus-5-5": reportedOpus(),
          "claude-sonnet-5-5": { inputTokens: 5, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
        })
      ],
      "session-1/subagents/agent-a.jsonl": [
        assistant("req-2", "claude-sonnet-5-5", { input_tokens: 5, output_tokens: 10 })
      ]
    }));
    expect(estimates).toEqual({});
  });

  it("uses only the last repeated cost-state record", async () => {
    const reported = { "claude-opus-5-5": reportedOpus({ inputTokens: 12 }) };
    const estimates = estimateClaudeUnloggedUsage(await parseSession({
      "session-1.jsonl": [
        costState({ "claude-opus-5-5": reportedOpus({ inputTokens: 999_999 }) }),
        assistant("req-1", "claude-opus-5-5", opusUsage),
        costState(reported),
        costState(reported)
      ]
    }));
    expect(estimatedRows(estimates)).toHaveLength(1);
    expect(estimatedRows(estimates)[0].totalTokens).toBe(10);
  });

  it("adds nothing when the session has no cost-state record", async () => {
    const summaries = await parseSession({
      "session-1.jsonl": [assistant("req-1", "claude-opus-5-5", opusUsage)]
    });
    expect(estimateClaudeUnloggedUsage(summaries)).toEqual({});
  });

  it("adds nothing when a resumed session has logged past its last cost-state record", async () => {
    const estimates = estimateClaudeUnloggedUsage(await parseSession({
      "session-1.jsonl": [
        assistant("req-1", "claude-opus-5-5", opusUsage),
        costState({ "claude-opus-5-5": reportedOpus() }),
        assistant("req-2", "claude-opus-5-5", opusUsage)
      ]
    }));
    expect(estimates).toEqual({});
  });

  it("adds nothing for a forked session, which inherits its parent's totals", async () => {
    const estimates = estimateClaudeUnloggedUsage(await parseSession({
      "session-1.jsonl": [
        { ...assistant("req-1", "claude-opus-5-5", opusUsage), forkedFrom: { sessionId: "parent", messageUuid: "m-1" } },
        costState({ "claude-opus-5-5": reportedOpus({ cacheReadInputTokens: 500_000 }) })
      ]
    }));
    expect(estimates).toEqual({});
  });

  it("ignores cost-state and fork text that only appears inside message content", async () => {
    const quoted = { type: "user", message: { content: JSON.stringify(costState({ "claude-opus-5-5": reportedOpus({ inputTokens: 500 }) })) + " \"forkedFrom\"" } };
    const estimates = estimateClaudeUnloggedUsage(await parseSession({
      "session-1.jsonl": [
        assistant("req-1", "claude-opus-5-5", opusUsage),
        quoted,
        costState({ "claude-opus-5-5": reportedOpus({ inputTokens: 7 }) })
      ]
    }));
    expect(estimatedRows(estimates)[0].totalTokens).toBe(5);
  });

  it("ignores a cost-state record that belongs to another session", async () => {
    const estimates = estimateClaudeUnloggedUsage(await parseSession({
      "session-1.jsonl": [
        assistant("req-1", "claude-opus-5-5", opusUsage),
        costState({ "claude-opus-5-5": reportedOpus({ inputTokens: 500 }) }, "other-session")
      ]
    }));
    expect(estimates).toEqual({});
  });

  it("matches models that carry a context suffix", async () => {
    const estimates = estimateClaudeUnloggedUsage(await parseSession({
      "session-1.jsonl": [
        assistant("req-1", "claude-opus-5-5", opusUsage),
        costState({ "claude-opus-5-5[1m]": reportedOpus({ inputTokens: 3 }) })
      ]
    }));
    expect(estimatedRows(estimates)).toHaveLength(1);
    expect(estimatedRows(estimates)[0]).toMatchObject({ model: "claude-opus-5-5", totalTokens: 1 });
  });

  it("dates the estimate to the session's last activity", async () => {
    const estimates = estimateClaudeUnloggedUsage(await parseSession({
      "session-1.jsonl": [
        assistant("req-1", "claude-opus-5-5", opusUsage, "2026-06-01T12:00:00.000Z"),
        assistant("req-2", "claude-opus-5-5", opusUsage, "2026-06-03T12:00:00.000Z"),
        costState({ "claude-opus-5-5": reportedOpus({
          inputTokens: 5,
          outputTokens: 200,
          cacheReadInputTokens: 2_000,
          cacheCreationInputTokens: 100,
          cacheCreationEphemeral1hInputTokens: 100
        }) })
      ]
    }));
    expect(Object.keys(Object.values(estimates)[0].daily)).toEqual(["2026-06-03"]);
  });
});
