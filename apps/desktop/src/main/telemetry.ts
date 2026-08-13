import { app } from "electron";
import { PostHog } from "posthog-node";
import type { PreferenceStore } from "./preferences";

declare const USAGEATLAS_POSTHOG_KEY: string;
declare const USAGEATLAS_POSTHOG_HOST: string;

type TelemetryProperty = boolean | number | string;

export class DesktopTelemetry {
  private client: PostHog | null = null;

  constructor(private readonly preferences: PreferenceStore) {
    if (preferences.get().anonymousAnalytics) this.enable();
  }

  get available(): boolean {
    return USAGEATLAS_POSTHOG_KEY.length > 0;
  }

  setEnabled(enabled: boolean): void {
    if (enabled) {
      this.enable();
      this.capture("desktop_analytics_enabled");
      return;
    }
    void this.shutdown();
  }

  capture(event: string, properties: Readonly<Record<string, TelemetryProperty>> = {}): void {
    if (!this.client || !this.preferences.get().anonymousAnalytics) return;
    this.client.capture({
      distinctId: this.preferences.getAnalyticsInstallationId(),
      event,
      disableGeoip: true,
      properties: {
        app_version: app.getVersion(),
        platform: process.platform,
        architecture: process.arch,
        packaged: app.isPackaged,
        $process_person_profile: false,
        ...properties
      }
    });
  }

  async shutdown(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.shutdown(2_000);
  }

  private enable(): void {
    if (this.client || !this.available) return;
    this.client = new PostHog(USAGEATLAS_POSTHOG_KEY, {
      host: USAGEATLAS_POSTHOG_HOST,
      persistence: "memory",
      flushAt: 1,
      flushInterval: 10_000,
      maxQueueSize: 100,
      privacyMode: true,
      enableExceptionAutocapture: false
    });
  }
}