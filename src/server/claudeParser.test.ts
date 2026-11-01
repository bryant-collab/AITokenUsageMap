import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseClaudeUsageFile } from "./claudeParser";

const makeClaudeRoot = async (): Promise<string> => fs.mkdtemp(path.join(os.tmpdir(), "claude-token-test-"));

const writeStatsCache = async (body: unknown): Promise<string> => {
  const dir = await makeClaudeRoot();
  const filePath = path.join(dir, "stats-cache.json");
  await fs.writeFile(filePath, JSON.stringify(body), "utf8");
  return filePath;
};

const writeTranscript = async (lines: string[]): Promise<string> => {
  const dir = await makeClaudeRoot();
  const projectDir = path.join(dir, "projects", "-tmp-repo");
  await fs.mkdir(projectDir, { recursive: true });
  const filePath = path.join(projectDir, "session-1.jsonl");
  await fs.writeFile(filePath, lines.join("\n"), "utf8");
  return filePath;
};

describe("parseClaudeUsageFile", () => {
  it("reads stats-cache daily model totals and activity counts", async () => {
    const file = await writeStatsCache({
      version: 1,
      dailyActivity: [
        { date: "2026-06-01", messageCount: 5, sessionCount: 2 }
      ],
      dailyModelTokens: [
        {
          date: "2026-06-01",
          tokensByModel: {
            "claude-sonnet-4": 150,
            "claude-opus-4": 50
          }
        }
      ],
      modelUsage: {
        "claude-sonnet-4": {
          inputTokens: 80,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 10,
          outputTokens: 40
        }
      }
    });

    const parsed = await parseClaudeUsageFile(file, "UTC");
    const sessions = parsed.daily["2026-06-01"];
    expect(sessions).toHaveLength(2);
    expect(sessions.reduce((sum, session) => sum + session.totalTokens, 0)).toBe(200);
    expect(sessions[0]).toMatchObject({
      sessionId: "claude-stats-2026-06-01-claude-sonnet-4",
      model: "claude-sonnet-4",
      inputTokens: 80,
      cachedInputTokens: 30,
      outputTokens: 40,
      totalTokens: 150
    });
    expect(parsed.dailyEventCounts?.["2026-06-01"]).toBe(5);
    expect(parsed.dailySessionCounts?.["2026-06-01"]).toBe(2);
    expect(parsed.dailyPriority).toBe(2);
  });

  it("reads transcript assistant usage with Claude cache read and creation tokens", async () => {
    const file = await writeTranscript([
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-01T12:00:00.000Z",
        sessionId: "session-1",
        message: {
          id: "msg-1",
          model: "claude-sonnet-4",
          usage: {
            input_tokens: 10,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 30,
            output_tokens: 5
          }
        }
      })
    ]);

    const parsed = await parseClaudeUsageFile(file, "UTC");
    const session = parsed.daily["2026-06-01"][0];
    expect(session.sessionId).toBe("session-1");
    expect(session.model).toBe("claude-sonnet-4");
    expect(session.inputTokens).toBe(10);
    expect(session.cachedInputTokens).toBe(50);
    expect(session.outputTokens).toBe(5);
    expect(session.totalTokens).toBe(65);
    expect(session.events).toBe(1);
    expect(parsed.events[0].usage.totalTokens).toBe(65);
    expect(parsed.dailyPriority).toBe(1);
  });

  it("separates cache writes by cache lifetime without changing cached totals", async () => {
    const file = await writeTranscript([
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-01T12:00:00.000Z",
        requestId: "req-split",
        message: {
          model: "claude-opus-5-5",
          usage: {
            input_tokens: 2,
            cache_read_input_tokens: 100,
            cache_creation_input_tokens: 50,
            cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 30 },
            output_tokens: 5
          }
        }
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-01T12:01:00.000Z",
        requestId: "req-unsplit",
        message: {
          model: "claude-opus-5-5",
          usage: { input_tokens: 1, cache_creation_input_tokens: 7, output_tokens: 1 }
        }
      })
    ]);

    const session = (await parseClaudeUsageFile(file, "UTC")).daily["2026-06-01"][0];
    expect(session.cachedInputTokens).toBe(157);
    expect(session.cacheWrite5mTokens).toBe(27);
    expect(session.cacheWrite1hTokens).toBe(30);
    expect(session.totalTokens).toBe(166);
  });

  it("deduplicates repeated transcript records by message id", async () => {
    const assistant = JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-01T12:00:00.000Z",
      session_id: "session-1",
      message: {
        id: "msg-repeat",
        model: "claude-sonnet-4",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15
        }
      }
    });
    const file = await writeTranscript([assistant, assistant]);

    const parsed = await parseClaudeUsageFile(file, "UTC");
    expect(parsed.tokenEvents).toBe(1);
    expect(parsed.daily["2026-06-01"][0].totalTokens).toBe(15);
  });

  it("reports malformed transcript lines that look like usage records", async () => {
    const file = await writeTranscript([
      "{\"type\":\"assistant\",\"message\":{\"usage\":",
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-01T12:01:00.000Z",
        message: {
          model: "claude-sonnet-4",
          usage: {
            input_tokens: 1,
            output_tokens: 1
          }
        }
      })
    ]);

    const parsed = await parseClaudeUsageFile(file, "UTC");
    expect(parsed.parseErrors).toBe(1);
    expect(parsed.tokenEvents).toBe(1);
    expect(parsed.daily["2026-06-01"][0].totalTokens).toBe(2);
  });
});
