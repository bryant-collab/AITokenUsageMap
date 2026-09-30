import { describe, expect, it } from "vitest";
import { squirrelActionFor } from "./squirrel";

describe("Squirrel installation events", () => {
  it.each(["--squirrel-install", "--squirrel-updated"])("creates shortcuts for %s", (argument) => {
    expect(squirrelActionFor("win32", argument)).toBe("--createShortcut");
  });

  it("removes shortcuts on uninstall", () => {
    expect(squirrelActionFor("win32", "--squirrel-uninstall")).toBe("--removeShortcut");
  });

  it("ignores normal launches and other platforms", () => {
    expect(squirrelActionFor("win32", "--squirrel-firstrun")).toBeNull();
    expect(squirrelActionFor("darwin", "--squirrel-install")).toBeNull();
  });
});
