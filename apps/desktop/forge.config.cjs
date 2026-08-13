const fs = require("node:fs");
const path = require("node:path");
const { VitePlugin } = require("@electron-forge/plugin-vite");
const { PluginBase } = require("@electron-forge/plugin-base");
const { flipFuses, FuseV1Options, FuseVersion } = require("@electron/fuses");
const { MakerDeb } = require("@electron-forge/maker-deb");
const { MakerDMG } = require("@electron-forge/maker-dmg");
const { MakerRpm } = require("@electron-forge/maker-rpm");
const { MakerSquirrel } = require("@electron-forge/maker-squirrel");
const { MakerZIP } = require("@electron-forge/maker-zip");
const { MakerAppImage } = require("@reforged/maker-appimage");

const resources = path.join(__dirname, "resources");
const iconDirectory = path.join(resources, "icons");
const installerDirectory = path.join(resources, "installer");
const platformIcon = process.platform === "win32"
  ? path.join(iconDirectory, "usageatlas.ico")
  : process.platform === "darwin"
    ? path.join(iconDirectory, "usageatlas.icns")
    : path.join(iconDirectory, "usageatlas.png");
const windowsSign = process.env.WINDOWS_CERTIFICATE_FILE
  ? {
      certificateFile: process.env.WINDOWS_CERTIFICATE_FILE,
      certificatePassword: process.env.WINDOWS_CERTIFICATE_PASSWORD
    }
  : undefined;
const osxSign = process.env.APPLE_SIGNING_IDENTITY
  ? { identity: process.env.APPLE_SIGNING_IDENTITY, hardenedRuntime: true }
  : undefined;
const osxNotarize = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER
  ? {
      appleApiKey: process.env.APPLE_API_KEY,
      appleApiKeyId: process.env.APPLE_API_KEY_ID,
      appleApiIssuer: process.env.APPLE_API_ISSUER
    }
  : undefined;

class CurrentFusesPlugin extends PluginBase {
  name = "current-fuses";

  constructor(config) {
    super(config);
  }

  getHooks() {
    return {
      packageAfterCopy: async (_forgeConfig, buildPath, _electronVersion, platform, arch) => {
        const applePlatform = platform === "darwin" || platform === "mas";
        const basePath = path.resolve(buildPath, "../..");
        const executable = applePlatform
          ? path.join(basePath, "MacOS", "Electron")
          : path.join(basePath, `electron${platform === "win32" ? ".exe" : ""}`);
        await flipFuses(executable, {
          resetAdHocDarwinSignature: applePlatform && arch === "arm64" && !osxSign,
          ...this.config
        });
      }
    };
  }
}

module.exports = {
  packagerConfig: {
    asar: true,
    // Ships the AppImage entry point; the deb and rpm carry an unused copy.
    afterExtract: [
      (buildPath, _electronVersion, platform, _arch, done) => {
        if (platform === "linux") {
          const launcher = path.join(buildPath, "appimage-launcher");
          fs.copyFileSync(path.join(installerDirectory, "appimage-launcher.sh"), launcher);
          fs.chmodSync(launcher, 0o755);
        }
        done();
      }
    ],
    appBundleId: "com.usageatlas.desktop",
    appCategoryType: "public.app-category.developer-tools",
    appCopyright: "Copyright UsageAtlas contributors",
    executableName: "UsageAtlas",
    extraResource: [iconDirectory],
    icon: platformIcon,
    name: "UsageAtlas",
    osxSign,
    osxNotarize,
    windowsSign,
    win32metadata: {
      CompanyName: "UsageAtlas",
      FileDescription: "AI provider usage at a glance",
      InternalName: "UsageAtlas",
      OriginalFilename: "UsageAtlas.exe",
      ProductName: "UsageAtlas"
    }
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: "UsageAtlas",
      authors: "UsageAtlas contributors",
      description: "Cross-platform AI provider usage dashboard",
      setupIcon: path.join(iconDirectory, "usageatlas.ico"),
      iconUrl: "https://usageatlas.com/icon.ico",
      windowsSign
    }),
    new MakerZIP({}, ["darwin", "win32"]),
    // Without these the volume shows stock Electron artwork; `name` must stay unset for the arch suffix.
    new MakerDMG({
      icon: path.join(iconDirectory, "usageatlas.icns"),
      background: path.join(installerDirectory, "dmg-background.png")
    }, ["darwin"]),
    // `bin` is what AppRun points at, so it is the launcher, not the binary.
    new MakerAppImage({
      options: {
        bin: "appimage-launcher",
        categories: ["Utility", "Development"],
        icon: path.join(iconDirectory, "usageatlas.png"),
        license: path.resolve(__dirname, "../../LICENSE")
      }
    }),
    // Both default `name` and `bin` to "@usageatlas/desktop"; the rest is what they cannot infer.
    new MakerRpm({
      options: {
        name: "usageatlas",
        bin: "UsageAtlas",
        genericName: "AI usage dashboard",
        categories: ["Utility", "Development"],
        homepage: "https://usageatlas.com",
        license: "MIT",
        icon: path.join(iconDirectory, "usageatlas.png")
      }
    }),
    new MakerDeb({
      options: {
        name: "usageatlas",
        bin: "UsageAtlas",
        genericName: "AI usage dashboard",
        categories: ["Utility", "Development"],
        maintainer: "UsageAtlas contributors",
        homepage: "https://usageatlas.com",
        icon: path.join(iconDirectory, "usageatlas.png")
      }
    })
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main/main.ts", config: "vite.main.config.ts" },
        { entry: "src/preload/preload.ts", config: "vite.preload.config.ts" },
        { entry: "src/engine/engine-entry.ts", config: "vite.main.config.ts" }
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }]
    }),
    new CurrentFusesPlugin({
      version: FuseVersion.V1,
      strictlyRequireAllFuses: true,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
      [FuseV1Options.WasmTrapHandlers]: true
    })
  ]
};
