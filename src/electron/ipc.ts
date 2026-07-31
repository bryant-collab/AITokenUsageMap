import type { WebFrameMain } from "electron";
import { ipcMain } from "electron";
import { desktopChannels } from "../shared/desktopApi";
import { getPricingForModels, setManualPricing } from "../server/pricing";
import { getDay, getModelUsageRange, getSummary, scanAllLogs } from "../server/scanner";
import { assertDateRange, assertHarnessId, assertIsoDate, assertModels, assertPricingUpdate } from "./ipcValidation";

type TrustedFrame = (frame: WebFrameMain | null) => boolean;

export const registerDesktopIpc = (isTrustedFrame: TrustedFrame): void => {
  const handle = <T extends unknown[]>(
    channel: string,
    handler: (...args: T) => unknown
  ): void => {
    ipcMain.handle(channel, (event, ...args: T) => {
      if (!isTrustedFrame(event.senderFrame)) throw new Error("Untrusted application frame.");
      return handler(...args);
    });
  };

  handle(desktopChannels.getSummary, () => getSummary());
  handle(desktopChannels.getDay, (harness: unknown, date: unknown) => (
    getDay(assertHarnessId(harness), assertIsoDate(date, "date"))
  ));
  handle(desktopChannels.getModelUsage, (fromValue: unknown, toValue: unknown) => {
    const { from, to } = assertDateRange(fromValue, toValue);
    return getModelUsageRange(from, to);
  });
  handle(desktopChannels.getPricing, (models: unknown) => getPricingForModels(assertModels(models)));
  handle(desktopChannels.savePricing, (update: unknown) => setManualPricing(assertPricingUpdate(update)));
  handle(desktopChannels.rescan, async () => {
    await scanAllLogs(true);
  });
};
