import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { parseRolloutFile } from "./parser";

const writeFixture = async (lines: string[]): Promise<string> => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-token-test-"));
  const filePath = path.join(dir, "rollout-test.jsonl");
  await fs.writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
};

const record = (timestamp: string, payload: unknown) => JSON.stringify({ timestamp, type: "event_msg", payload });

const tokenCount = (timestamp: string, last: number, cumulative: number) => record(timestamp, {
  type: "token_count",
  info: {
    last_token_usage: { input_tokens: last, output_tokens: 0, total_tokens: last },
    total_token_usage: { input_tokens: cumulative, output_tokens: 0, total_tokens: cumulative }
  }
});

const sessionMeta = (timestamp: string, payload: Record<string, unknown>) => JSON.stringify({
  timestamp,
  type: "session_meta",
  payload: { id: "s1", source: "vscode", ...payload }
});

const usageRecord = (timestamp: string, total: number) => JSON.stringify({
  timestamp,
  type: "token_usage_record",
  payload: { usage: { input_tokens: total, output_tokens: 0, total_tokens: total } }
});

const turnContext = (timestamp: string, model: string) => JSON.stringify({
  timestamp,
  type: "turn_context",
  payload: { model }
});

describe("parseRolloutFile", () => {
  it("reads compressed rollouts", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-token-test-"));
    const file = path.join(dir, "rollout-test.jsonl.zst");
    const lines = [
      sessionMeta("2026-06-01T12:00:00.000Z", {}),
      turnContext("2026-06-01T12:00:00.100Z", "gpt-6-luna"),
      tokenCount("2026-06-01T12:00:05.000Z", 20, 20)
    ];
    await fs.writeFile(file, zlib.zstdCompressSync(Buffer.from(lines.join("\n"))));

    const parsed = await parseRolloutFile(file, "UTC");
    expect(parsed.daily["2026-06-01"][0]).toMatchObject({ model: "gpt-6-luna", totalTokens: 20 });
  });

  it("rejects a corrupt compressed rollout instead of hanging or reporting nothing", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-token-test-"));
    const file = path.join(dir, "rollout-test.jsonl.zst");
    await fs.writeFile(file, Buffer.from("this is not zstd data"));

    await expect(parseRolloutFile(file, "UTC")).rejects.toThrow();
  });

  it("skips token events a subagent replays from its parent", async () => {
    const file = await writeFixture([
      sessionMeta("2026-06-01T12:00:00.000Z", { source: { subagent: { other: "guardian" } } }),
      tokenCount("2026-06-01T12:00:00.001Z", 500, 9_000),
      tokenCount("2026-06-01T12:00:00.001Z", 600, 9_600),
      turnContext("2026-06-01T12:00:00.002Z", "gpt-6-luna"),
      usageRecord("2026-06-01T12:00:03.000Z", 30),
      tokenCount("2026-06-01T12:00:03.001Z", 30, 9_630)
    ]);

    const parsed = await parseRolloutFile(file, "UTC");
    const rows = parsed.daily["2026-06-01"];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "gpt-6-luna", totalTokens: 30, events: 1 });
  });

  it("stops treating events as replayed once the window has passed", async () => {
    const file = await writeFixture([
      sessionMeta("2026-06-01T12:00:00.000Z", { parent_thread_id: "parent" }),
      turnContext("2026-06-01T12:00:00.100Z", "gpt-6-luna"),
      tokenCount("2026-06-01T12:00:02.000Z", 40, 40),
      tokenCount("2026-06-01T12:00:02.500Z", 50, 90)
    ]);

    const parsed = await parseRolloutFile(file, "UTC");
    expect(parsed.daily["2026-06-01"][0].totalTokens).toBe(90);
  });

  it("counts a fast first response in a top-level session", async () => {
    const file = await writeFixture([
      sessionMeta("2026-06-01T12:00:00.000Z", {}),
      turnContext("2026-06-01T12:00:00.100Z", "gpt-6-luna"),
      tokenCount("2026-06-01T12:00:00.500Z", 40, 40)
    ]);

    const parsed = await parseRolloutFile(file, "UTC");
    expect(parsed.daily["2026-06-01"][0].totalTokens).toBe(40);
  });

  it("does not count repeated usage when the cumulative total is unchanged", async () => {
    const file = await writeFixture([
      sessionMeta("2026-06-01T12:00:00.000Z", {}),
      turnContext("2026-06-01T12:00:00.100Z", "gpt-6-luna"),
      tokenCount("2026-06-01T12:00:05.000Z", 100, 100),
      tokenCount("2026-06-01T12:10:00.000Z", 100, 100),
      tokenCount("2026-06-01T12:10:05.000Z", 60, 160)
    ]);

    const parsed = await parseRolloutFile(file, "UTC");
    expect(parsed.daily["2026-06-01"][0]).toMatchObject({ totalTokens: 160, events: 2 });
  });

  it("counts an unchanged total when a usage record shows a real request", async () => {
    const file = await writeFixture([
      sessionMeta("2026-06-01T12:00:00.000Z", {}),
      turnContext("2026-06-01T12:00:00.100Z", "gpt-6-luna"),
      usageRecord("2026-06-01T12:00:04.900Z", 100),
      tokenCount("2026-06-01T12:00:05.000Z", 100, 100),
      usageRecord("2026-06-01T12:01:04.900Z", 100),
      tokenCount("2026-06-01T12:01:05.000Z", 100, 100)
    ]);

    const parsed = await parseRolloutFile(file, "UTC");
    expect(parsed.daily["2026-06-01"][0]).toMatchObject({ totalTokens: 200, events: 2 });
  });

  it("uses a usage record's figure when the following token event reports less", async () => {
    const file = await writeFixture([
      sessionMeta("2026-06-01T12:00:00.000Z", {}),
      turnContext("2026-06-01T12:00:00.100Z", "gpt-6-luna"),
      usageRecord("2026-06-01T12:00:05.000Z", 100),
      tokenCount("2026-06-01T12:00:05.001Z", 100, 100),
      usageRecord("2026-06-01T12:01:05.000Z", 245_000),
      tokenCount("2026-06-01T12:01:05.001Z", 16_000, 100)
    ]);

    const parsed = await parseRolloutFile(file, "UTC");
    expect(parsed.daily["2026-06-01"][0]).toMatchObject({ totalTokens: 245_100, events: 2 });
    expect(parsed.tokenEvents).toBe(2);
  });

  it("ignores a usage record copied from another thread", async () => {
    const file = await writeFixture([
      sessionMeta("2026-06-01T12:00:00.000Z", { source: "exec" }),
      turnContext("2026-06-01T12:00:00.100Z", "gpt-6-luna"),
      JSON.stringify({
        timestamp: "2026-06-01T12:00:00.200Z",
        type: "token_usage_record",
        payload: { thread_id: "parent", usage: { input_tokens: 900, output_tokens: 0, total_tokens: 900 } }
      }),
      tokenCount("2026-06-01T12:00:05.000Z", 40, 40)
    ]);

    const parsed = await parseRolloutFile(file, "UTC");
    expect(parsed.daily["2026-06-01"][0].totalTokens).toBe(40);
  });

  it("keeps counting after the cumulative total resets", async () => {
    const file = await writeFixture([
      sessionMeta("2026-06-01T12:00:00.000Z", {}),
      turnContext("2026-06-01T12:00:00.100Z", "gpt-6-luna"),
      tokenCount("2026-06-01T12:00:05.000Z", 100, 100),
      tokenCount("2026-06-01T12:01:05.000Z", 25, 25)
    ]);

    const parsed = await parseRolloutFile(file, "UTC");
    expect(parsed.daily["2026-06-01"][0].totalTokens).toBe(125);
  });

  it("sums last_token_usage without double-counting cumulative totals", async () => {
    const file = await writeFixture([
      JSON.stringify({ timestamp: "2026-06-01T00:00:00.000Z", type: "session_meta", payload: { id: "s1", cwd: "repo", originator: "codex_vscode" } }),
      record("2026-06-01T12:00:00.000Z", {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 },
          total_token_usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 }
        }
      }),
      record("2026-06-01T12:01:00.000Z", {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: 20, cached_input_tokens: 4, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 25 },
          total_token_usage: { input_tokens: 30, cached_input_tokens: 6, output_tokens: 8, reasoning_output_tokens: 3, total_tokens: 38 }
        }
      })
    ]);
    const parsed = await parseRolloutFile(file, "UTC");
    const session = parsed.daily["2026-06-01"][0];
    expect(session.totalTokens).toBe(38);
    expect(session.cachedInputTokens).toBe(6);
    expect(session.events).toBe(2);
  });

  it("falls back to cumulative deltas when last_token_usage is missing", async () => {
    const file = await writeFixture([
      JSON.stringify({ timestamp: "2026-06-01T00:00:00.000Z", type: "session_meta", payload: { id: "s1" } }),
      record("2026-06-01T12:00:00.000Z", {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }
      }),
      record("2026-06-01T12:01:00.000Z", {
        type: "token_count",
        info: { total_token_usage: { input_tokens: 25, output_tokens: 5, total_tokens: 30 } }
      })
    ]);
    const parsed = await parseRolloutFile(file, "UTC");
    expect(parsed.daily["2026-06-01"][0].totalTokens).toBe(30);
  });

  it("ignores null info events and reports malformed json lines", async () => {
    const file = await writeFixture([
      JSON.stringify({ timestamp: "2026-06-01T00:00:00.000Z", type: "session_meta", payload: { id: "s1" } }),
      record("2026-06-01T12:00:00.000Z", { type: "token_count", info: null }),
      "{\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\"",
      record("2026-06-01T12:01:00.000Z", {
        type: "token_count",
        info: { last_token_usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
      })
    ]);
    const parsed = await parseRolloutFile(file, "UTC");
    expect(parsed.parseErrors).toBe(1);
    expect(parsed.tokenEvents).toBe(1);
    expect(parsed.daily["2026-06-01"][0].totalTokens).toBe(2);
  });

  it("deduplicates repeated token events", async () => {
    const event = record("2026-06-01T12:00:00.000Z", {
      type: "token_count",
      info: {
        last_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
        total_token_usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 }
      }
    });
    const file = await writeFixture([
      JSON.stringify({ timestamp: "2026-06-01T00:00:00.000Z", type: "session_meta", payload: { id: "s1" } }),
      event,
      event
    ]);
    const parsed = await parseRolloutFile(file, "UTC");
    expect(parsed.daily["2026-06-01"][0].totalTokens).toBe(12);
    expect(parsed.tokenEvents).toBe(1);
  });
});
