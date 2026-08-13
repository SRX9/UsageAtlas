import { homedir } from "node:os";
import path from "node:path";

export interface CredentialLocations {
  claude: string;
}

export function credentialLocations(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir()
): CredentialLocations {
  const claudeRoot = nonEmpty(environment.CLAUDE_CONFIG_DIR) ?? path.join(homeDirectory, ".claude");
  return {
    claude: path.join(claudeRoot, ".credentials.json")
  };
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}