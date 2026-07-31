import path from "node:path";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

const iconRoot = path.resolve("assets/icons/icon");
const linuxIcon = path.resolve("assets/icons/png/512.png");

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    prune: false,
    executableName: "ai-token-usage",
    icon: iconRoot,
    appBundleId: "com.aitokenusage.desktop"
  },
  makers: [
    new MakerSquirrel({
      name: "ai_token_usage",
      setupIcon: `${iconRoot}.ico`
    }),
    new MakerDMG({
      icon: `${iconRoot}.icns`
    }),
    new MakerZIP({}, ["darwin"]),
    new MakerDeb({
      options: { icon: linuxIcon }
    }),
    new MakerRpm({
      options: { icon: linuxIcon }
    })
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/electron/main.ts", config: "vite.main.config.ts" },
        { entry: "src/electron/preload.ts", config: "vite.preload.config.ts" }
      ],
      renderer: [
        { name: "main_window", config: "vite.renderer.config.ts" }
      ]
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true
    })
  ]
};

export default config;
