import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const environment = { ...loadEnv(mode, __dirname, ""), ...process.env };
  return {
    define: {
      USAGEATLAS_POSTHOG_KEY: JSON.stringify(environment.POSTHOG_PROJECT_TOKEN ?? ""),
      USAGEATLAS_POSTHOG_HOST: JSON.stringify(environment.POSTHOG_HOST ?? "https://usageatlas.com/signals")
    },
    build: {
      rollupOptions: { external: ["electron", "node:sqlite"] }
    }
  };
});