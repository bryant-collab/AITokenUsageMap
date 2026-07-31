import path from "node:path";
import { describe, expect, it } from "vitest";
import { cachePathForUserData, defaultClaudeRootsFor, defaultCopilotCliRootsFor, defaultCopilotRootsFor, defaultCopilotUsageRootsFor } from "./config";

const rootsFor = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string) => (
  defaultCopilotRootsFor(platform, env, home)
);

describe("defaultCopilotRootsFor", () => {
  it("uses APPDATA for Windows VS Code storage roots", () => {
    expect(rootsFor("win32", { APPDATA: path.join("C:", "Users", "dev", "AppData", "Roaming") }, path.join("C:", "Users", "dev"))).toEqual([
      path.join("C:", "Users", "dev", "AppData", "Roaming", "Code", "User", "workspaceStorage"),
      path.join("C:", "Users", "dev", "AppData", "Roaming", "Code - Insiders", "User", "workspaceStorage"),
      path.join("C:", "Users", "dev", "AppData", "Roaming", "VSCodium", "User", "workspaceStorage")
    ]);
  });

  it("uses Library/Application Support for macOS VS Code storage roots", () => {
    expect(rootsFor("darwin", {}, path.join("Users", "dev"))).toEqual([
      path.join("Users", "dev", "Library", "Application Support", "Code", "User", "workspaceStorage"),
      path.join("Users", "dev", "Library", "Application Support", "Code - Insiders", "User", "workspaceStorage"),
      path.join("Users", "dev", "Library", "Application Support", "VSCodium", "User", "workspaceStorage")
    ]);
  });

  it("uses XDG_CONFIG_HOME for Linux VS Code storage roots", () => {
    expect(rootsFor("linux", { XDG_CONFIG_HOME: path.join("home", "dev", ".xdg-config") }, path.join("home", "dev"))).toEqual([
      path.join("home", "dev", ".xdg-config", "Code", "User", "workspaceStorage"),
      path.join("home", "dev", ".xdg-config", "Code - Insiders", "User", "workspaceStorage"),
      path.join("home", "dev", ".xdg-config", "VSCodium", "User", "workspaceStorage")
    ]);
  });

  it("falls back to ~/.config for Linux VS Code storage roots", () => {
    expect(rootsFor("linux", {}, path.join("home", "dev"))).toEqual([
      path.join("home", "dev", ".config", "Code", "User", "workspaceStorage"),
      path.join("home", "dev", ".config", "Code - Insiders", "User", "workspaceStorage"),
      path.join("home", "dev", ".config", "VSCodium", "User", "workspaceStorage")
    ]);
  });
});

describe("defaultCopilotUsageRootsFor", () => {
  it("includes VS Code and Copilot CLI roots on Windows", () => {
    const home = path.join("C:", "Users", "dev");
    expect(defaultCopilotUsageRootsFor("win32", { APPDATA: path.join(home, "AppData", "Roaming") }, home)).toEqual([
      path.join(home, "AppData", "Roaming", "Code", "User", "workspaceStorage"),
      path.join(home, "AppData", "Roaming", "Code - Insiders", "User", "workspaceStorage"),
      path.join(home, "AppData", "Roaming", "VSCodium", "User", "workspaceStorage"),
      path.join(home, ".copilot", "session-state")
    ]);
  });

  it("includes VS Code and Copilot CLI roots on macOS", () => {
    const home = path.join("Users", "dev");
    expect(defaultCopilotUsageRootsFor("darwin", {}, home)).toEqual([
      path.join(home, "Library", "Application Support", "Code", "User", "workspaceStorage"),
      path.join(home, "Library", "Application Support", "Code - Insiders", "User", "workspaceStorage"),
      path.join(home, "Library", "Application Support", "VSCodium", "User", "workspaceStorage"),
      path.join(home, ".copilot", "session-state")
    ]);
  });

  it("includes VS Code and Copilot CLI roots on Linux", () => {
    const home = path.join("home", "dev");
    expect(defaultCopilotUsageRootsFor("linux", { XDG_CONFIG_HOME: path.join(home, ".config") }, home)).toEqual([
      path.join(home, ".config", "Code", "User", "workspaceStorage"),
      path.join(home, ".config", "Code - Insiders", "User", "workspaceStorage"),
      path.join(home, ".config", "VSCodium", "User", "workspaceStorage"),
      path.join(home, ".copilot", "session-state")
    ]);
  });

  it("uses COPILOT_HOME for the CLI root on every platform", () => {
    const home = path.join("Users", "dev");
    const copilotHome = path.join("custom", "copilot-home");
    expect(defaultCopilotUsageRootsFor("darwin", { COPILOT_HOME: copilotHome }, home).at(-1)).toBe(path.join(copilotHome, "session-state"));
    expect(defaultCopilotUsageRootsFor("linux", { COPILOT_HOME: copilotHome }, home).at(-1)).toBe(path.join(copilotHome, "session-state"));
    expect(defaultCopilotUsageRootsFor("win32", { COPILOT_HOME: copilotHome }, home).at(-1)).toBe(path.join(copilotHome, "session-state"));
  });
});

describe("defaultClaudeRootsFor", () => {
  it("uses CLAUDE_CONFIG_DIR when present", () => {
    expect(defaultClaudeRootsFor({ CLAUDE_CONFIG_DIR: path.join("D:", "ClaudeData") }, path.join("C:", "Users", "dev"))).toEqual([
      path.join("D:", "ClaudeData")
    ]);
  });

  it("falls back to ~/.claude", () => {
    expect(defaultClaudeRootsFor({}, path.join("home", "dev"))).toEqual([
      path.join("home", "dev", ".claude")
    ]);
  });
});

describe("defaultCopilotCliRootsFor", () => {
  it("uses COPILOT_HOME when present", () => {
    expect(defaultCopilotCliRootsFor({ COPILOT_HOME: path.join("D:", "CopilotData") }, path.join("C:", "Users", "dev"))).toEqual([
      path.join("D:", "CopilotData", "session-state")
    ]);
  });

  it("falls back to ~/.copilot/session-state", () => {
    expect(defaultCopilotCliRootsFor({}, path.join("home", "dev"))).toEqual([
      path.join("home", "dev", ".copilot", "session-state")
    ]);
  });
});

describe("cachePathForUserData", () => {
  it("stores generated scanner data beneath the application user-data directory", () => {
    expect(cachePathForUserData(path.join("home", "dev", "AI Token Usage"))).toBe(
      path.join("home", "dev", "AI Token Usage", "scanner-cache", "index.json")
    );
  });
});
