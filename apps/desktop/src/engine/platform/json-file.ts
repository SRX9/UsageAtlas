import { readFile, stat } from "node:fs/promises";
import { ProviderError } from "../provider";

const MAXIMUM_CREDENTIAL_BYTES = 1_048_576;

export async function readCredentialJson(path: string, providerName: string): Promise<unknown> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    throw new ProviderError(
      "credentials_missing",
      `${providerName} credentials were not found. Sign in with the provider CLI, then refresh.`
    );
  }
  if (size > MAXIMUM_CREDENTIAL_BYTES) {
    throw new ProviderError("credentials_invalid", `${providerName} credentials are invalid.`);
  }
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new ProviderError("credentials_invalid", `${providerName} credentials are invalid.`);
  }
}
