import { homedir } from "node:os";
import type { ProviderAdapter } from "../provider";
import { createPricingCatalogLoader } from "../analytics/models-dev";
import { createClaudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import { createCursorAdapter } from "./cursor";
import { createOpenCodeAdapter } from "./opencode";

export function createProviderAdapters(): ProviderAdapter[] {
  const pricingCatalogLoader = createPricingCatalogLoader({ homeDirectory: homedir() });
  return [
    createCodexAdapter({ pricingCatalogLoader }),
    createClaudeAdapter({ pricingCatalogLoader }),
    createCursorAdapter(),
    createOpenCodeAdapter()
  ];
}
