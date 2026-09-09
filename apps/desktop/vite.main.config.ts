import { defineConfig, loadEnv } from "vite";
import path from "node:path";

export default defineConfig(({ mode }) => {
  const environment = { ...loadEnv(mode, path.resolve(__dirname, "../../.."), ""), ...process.env };
  return {
    define: {
      USAGEATLAS_CLOUD_URL: JSON.stringify(environment.USAGEATLAS_CLOUD_URL || "https://usageatlas.com"),
      USAGEATLAS_POSTHOG_KEY: JSON.stringify(environment.POSTHOG_PROJECT_TOKEN ?? ""),
      USAGEATLAS_POSTHOG_HOST: JSON.stringify(environment.POSTHOG_HOST || "https://usageatlas.com/signals")
    },
    build: {
      rollupOptions: { external: ["electron", "node:sqlite"] }
    }
  };
});
