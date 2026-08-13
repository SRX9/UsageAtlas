import type { ProviderAdapter } from "../provider";
import { createClaudeAdapter } from "./claude";
import { createCodexAdapter } from "./codex";
import { createCursorAdapter } from "./cursor";
import { createOpenCodeAdapter } from "./opencode";

export function createProviderAdapters(): ProviderAdapter[] {
  return [createCodexAdapter(), createClaudeAdapter(), createCursorAdapter(), createOpenCodeAdapter()];
}
