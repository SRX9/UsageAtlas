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
// Electron ships a `locales` pak for every language it knows (47 MB in 0.4.0).
// The interface is translated into five, so the rest is dead weight in every
// installer and portable archive. `en-US` must survive: Chromium loads it as the
// fallback whenever a requested catalog is missing.
const KEPT_ELECTRON_LOCALES = new Set(["en-US", "fr", "es", "zh-CN", "hi"]);
// Every file in `icons` ships twice: `extraResource` copies the directory into
// the packaged app and the renderer serves it as its Vite `publicDir`. Only the
// PNG and the ICO are read at runtime, so build-only artwork lives in
// `installer` alongside the DMG background instead.
const iconDirectory = path.join(resources, "icons");
const windowsDirectory = path.join(resources, "windows");
const installerDirectory = path.join(resources, "installer");
const macIcon = path.join(installerDirectory, "usageatlas.icns");
const platformIcon = process.platform === "win32"
  ? path.join(iconDirectory, "usageatlas.ico")
  : process.platform === "darwin"
    ? macIcon
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
        const locales = path.join(basePath, "locales");
        try {
          for (const file of fs.readdirSync(locales)) {
            if (file.endsWith(".pak") && !KEPT_ELECTRON_LOCALES.has(file.slice(0, -4)))
              fs.rmSync(path.join(locales, file));
          }
        } catch {
          // A platform layout without a locales folder keeps all of them.
        }
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
    extraResource: [iconDirectory, windowsDirectory],
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
      // The product name stays "UsageAtlas": the installed app, its data folder and
      // the Squirrel app id are what make updates land on an existing install.
      name: "UsageAtlas",
      authors: "UsageAtlas Unofficial fork contributors",
      description: "Cross-platform AI provider usage dashboard (unofficial fork)",
      setupIcon: path.join(iconDirectory, "usageatlas.ico"),
      // Served from this fork's own repository rather than the original project's site.
      iconUrl: "https://raw.githubusercontent.com/Artleboss2/UsageAtlas-Unofficial/main/apps/desktop/resources/icons/usageatlas.ico",
      windowsSign
    }),
    new MakerZIP({}, ["darwin", "win32"]),
    // Without these the volume shows stock Electron artwork; `name` must stay unset for the arch suffix.
    // ULFO is LZFSE rather than the default zlib: a smaller image that also
    // decompresses faster, readable since macOS 10.11 and so by every release
    // this Electron version supports.
    new MakerDMG({
      format: "ULFO",
      icon: macIcon,
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
        homepage: "https://github.com/Artleboss2/UsageAtlas-Unofficial",
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
        maintainer: "UsageAtlas Unofficial fork contributors",
        homepage: "https://github.com/Artleboss2/UsageAtlas-Unofficial",
        icon: path.join(iconDirectory, "usageatlas.png")
      }
    })
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/main/main.ts", config: "vite.main.config.ts" },
        { entry: "src/preload/preload.ts", config: "vite.preload.config.ts" },
        { entry: "src/engine/engine-entry.ts", config: "vite.main.config.ts" },
        { entry: "src/engine/analytics/antigravity-worker.ts", config: "vite.main.config.ts" }
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
