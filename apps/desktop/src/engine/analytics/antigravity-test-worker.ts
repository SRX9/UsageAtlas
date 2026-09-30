import { builtinModules } from "node:module";
import path from "node:path";
import { build } from "vite";

/** Exercise the same bundled Node worker that Forge ships, including real SQLite access. */
export async function buildAntigravityTestWorker(): Promise<string> {
  const directory = path.resolve(__dirname, "../../../.vite", `antigravity-test-${process.pid}`);
  await build({
    configFile: false, logLevel: "silent",
    build: {
      target: "node22", outDir: directory, emptyOutDir: false,
      lib: { entry: path.join(__dirname, "antigravity-worker.ts"), formats: ["cjs"], fileName: () => "antigravity-worker.cjs" },
      rollupOptions: { external: ["node:sqlite", ...builtinModules, ...builtinModules.map(name => `node:${name}`)] }
    }
  });
  return path.join(directory, "antigravity-worker.cjs");
}
