import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const desktopRoot = path.dirname(fileURLToPath(import.meta.url));
const developmentStyleNonce = randomBytes(16).toString("hex");

export default defineConfig(({ command }) => {
  const isDevelopment = command === "serve";
  return {
    base: "./",
    publicDir: path.join(desktopRoot, "resources/icons"),
    root: path.join(desktopRoot, "src/renderer"),
    resolve: {
      alias: { "@": path.join(desktopRoot, "src/renderer") },
      // Forge defaults this to true, which hides nested dependencies in Bun's isolated store.
      preserveSymlinks: false
    },
    build: { outDir: path.join(desktopRoot, ".vite/renderer/main_window") },
    html: isDevelopment ? { cspNonce: developmentStyleNonce } : undefined,
    plugins: [
      {
        name: "usageatlas-renderer-csp",
        transformIndexHtml(html: string) {
          const nonceSource = isDevelopment ? ` 'nonce-${developmentStyleNonce}'` : "";
          const connectSource = isDevelopment ? " ws://localhost:* ws://127.0.0.1:*" : "";
          return html
            .replace("__VITE_STYLE_NONCE_SOURCE__", nonceSource)
            .replace("__VITE_CONNECT_SOURCE__", connectSource);
        }
      },
      tailwindcss(),
      react()
    ]
  };
});