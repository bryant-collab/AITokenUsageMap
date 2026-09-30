import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, net, protocol, session, shell } from "electron";
import { configureUserDataPath } from "../server/config";
import { registerDesktopIpc } from "./ipc";
import { handleSquirrelEvent } from "./squirrel";

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string | undefined;
declare const MAIN_WINDOW_VITE_NAME: string;

const squirrelEventHandled = handleSquirrelEvent();
const APP_HOST = "bundle";
const EXTERNAL_HOSTS = new Set([
  "developers.openai.com",
  "platform.claude.com",
  "docs.github.com"
]);

protocol.registerSchemesAsPrivileged([{
  scheme: "app",
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true
  }
}]);

const hasSingleInstanceLock = !squirrelEventHandled && app.requestSingleInstanceLock();
if (!squirrelEventHandled && !hasSingleInstanceLock) app.quit();

let mainWindow: BrowserWindow | null = null;

const isTrustedUrl = (value: string): boolean => {
  try {
    const url = new URL(value);
    if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
      return url.origin === new URL(MAIN_WINDOW_VITE_DEV_SERVER_URL).origin;
    }
    return url.protocol === "app:" && url.host === APP_HOST;
  } catch {
    return false;
  }
};

const registerAppProtocol = (): void => {
  const rendererRoot = path.resolve(__dirname, "../renderer", MAIN_WINDOW_VITE_NAME);
  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";
    const assetPath = path.resolve(rendererRoot, relativePath);
    const relativeToRoot = path.relative(rendererRoot, assetPath);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      return new Response("Not found", { status: 404 });
    }
    return net.fetch(pathToFileURL(assetPath).toString());
  });
};

const createWindow = async (): Promise<void> => {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 760,
    minHeight: 600,
    show: false,
    backgroundColor: "#f7f8fa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const externalUrl = new URL(url);
      if (externalUrl.protocol === "https:" && EXTERNAL_HOSTS.has(externalUrl.host)) {
        void shell.openExternal(externalUrl.toString());
      }
    } catch {
      // Invalid links are denied below.
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault();
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadURL(`app://${APP_HOST}/index.html`);
  }
};

if (hasSingleInstanceLock) {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    configureUserDataPath(app.getPath("userData"));
    registerAppProtocol();
    registerDesktopIpc((frame) => Boolean(frame && isTrustedUrl(frame.url)));
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    await createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow();
    });
  }).catch((error: unknown) => {
    console.error("Failed to start AI Token Usage", error);
    app.quit();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
