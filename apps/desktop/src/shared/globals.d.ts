import type { UsageAtlasDesktopAPI } from "./desktop-api";

declare global {
  interface Window {
    usageAtlas: UsageAtlasDesktopAPI;
  }
}

export {};
