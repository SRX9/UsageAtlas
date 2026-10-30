import { homedir } from "node:os";
import type { ProviderAdapter } from "../provider";
import { createPricingCatalogLoader } from "../analytics/models-dev";
import { createClaudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import { createCursorAdapter } from "./cursor";
import { createOpenCodeAdapter } from "./opencode";
import { createLocalToolAdapter } from "./local-tools";
import { createJsonFileAdapter } from "./local-files";
import { createWarpAdapter } from "./warp";
import { createKimiAdapter } from "./kimi";
import { createKiloAdapter } from "./kilo";
import { createCopilotAdapter } from "./copilot";
import { createFactoryAdapter } from "./factory";
import { createAmpAdapter } from "./amp";
import { createQoderAdapter } from "./qoder";
import { createZaiAdapter } from "./zai";
import { createFreebuffAdapter } from "./freebuff";

export function createProviderAdapters(): ProviderAdapter[] {
  const pricingCatalogLoader = createPricingCatalogLoader({ homeDirectory: homedir() });
  return [
    createCodexAdapter({ pricingCatalogLoader }),
    createClaudeAdapter({ pricingCatalogLoader }),
    createCursorAdapter(),
    createOpenCodeAdapter(),
    createLocalToolAdapter("antigravity", { pricingCatalogLoader }),
    createLocalToolAdapter("pi", { pricingCatalogLoader }),
    createLocalToolAdapter("muse"),
    createFreebuffAdapter({ pricingCatalogLoader }),
    createWarpAdapter(), createKimiAdapter(), createKiloAdapter(), createCopilotAdapter(),
    createFactoryAdapter(), createAmpAdapter(), createQoderAdapter(), createZaiAdapter(),
    createJsonFileAdapter("gemini"), createJsonFileAdapter("qwen"),
    createJsonFileAdapter("cline"), createJsonFileAdapter("roo")
  ];
}
