import { spawn } from "node:child_process";
import path from "node:path";
import { app } from "electron";

type SquirrelAction = "--createShortcut" | "--removeShortcut" | "obsolete" | null;

export const squirrelActionFor = (platform: NodeJS.Platform, argument: string | undefined): SquirrelAction => {
  if (platform !== "win32") return null;
  if (argument === "--squirrel-install" || argument === "--squirrel-updated") return "--createShortcut";
  if (argument === "--squirrel-uninstall") return "--removeShortcut";
  if (argument === "--squirrel-obsolete") return "obsolete";
  return null;
};

export const handleSquirrelEvent = (): boolean => {
  const action = squirrelActionFor(process.platform, process.argv[1]);
  if (!action) return false;

  if (action === "obsolete") {
    app.quit();
    return true;
  }

  const updateExe = path.resolve(process.execPath, "..", "..", "Update.exe");
  const appExe = path.basename(process.execPath);
  const child = spawn(updateExe, [action, appExe], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.on("error", (error) => console.error("Failed to update application shortcuts", error));
  child.unref();
  setTimeout(() => app.quit(), 1000);
  return true;
};
