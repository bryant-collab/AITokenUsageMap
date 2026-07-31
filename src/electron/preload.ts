import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi } from "../shared/desktopApi";
import { desktopChannels } from "../shared/desktopApi";

const desktopApi: DesktopApi = {
  getSummary: () => ipcRenderer.invoke(desktopChannels.getSummary),
  getDay: (harness, date) => ipcRenderer.invoke(desktopChannels.getDay, harness, date),
  getModelUsage: (from, to) => ipcRenderer.invoke(desktopChannels.getModelUsage, from, to),
  getPricing: (models) => ipcRenderer.invoke(desktopChannels.getPricing, models),
  savePricing: (update) => ipcRenderer.invoke(desktopChannels.savePricing, update),
  rescan: () => ipcRenderer.invoke(desktopChannels.rescan)
};

contextBridge.exposeInMainWorld("desktopApi", desktopApi);
