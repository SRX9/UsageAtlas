import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { QUOTA_PROVIDERS, validateProviderCredential, type QuotaProviderId, type ProviderCredential } from "../../shared/quota-providers";
import { ProviderError } from "../provider";

export interface CredentialOptions { environment?: NodeJS.ProcessEnv; homeDirectory?: string }
export async function resolveQuotaCredential(id: QuotaProviderId, options: CredentialOptions): Promise<ProviderCredential | null> {
  const env = options.environment ?? process.env;
  let secret = env[QUOTA_PROVIDERS[id].environment]?.trim();
  const home = options.homeDirectory ?? homedir();
  if (!secret && id === "warp") secret = env.WARP_TOKEN?.trim();
  if (!secret && id === "kilo") {
    const text = await smallFile(path.join(env.XDG_DATA_HOME || path.join(home, ".local", "share"), "kilo", "auth.json"));
    if (text !== null) {
      try { secret = (JSON.parse(text) as { kilo?: { access?: string } }).kilo?.access; }
      catch { throw new ProviderError("credentials_invalid", "Kilo's local sign-in could not be read. Run kilo auth login again."); }
    }
  }
  if (!secret && id === "factory") {
    const text = await smallFile(path.join(home, ".factory", ".env"));
    secret = text?.match(/^\s*(?:export\s+)?FACTORY_API_KEY\s*=\s*(.+?)\s*$/mu)?.[1]?.trim();
    if (secret?.startsWith('"') && secret.endsWith('"') || secret?.startsWith("'") && secret.endsWith("'")) secret = secret.slice(1, -1);
  }
  if (!secret) return null;
  const rawRegion = id === "kimi" ? env.KIMI_REGION : id === "qoder" ? env.QODER_REGION : undefined;
  if (rawRegion && !["china", "global"].includes(rawRegion)) throw new ProviderError("credentials_invalid", "Provider region must be global or china.");
  try {
    return validateProviderCredential(id, { secret,
      ...(rawRegion ? { region: rawRegion } : {}),
      ...(id === "kilo" && env.KILO_ORGANIZATION_ID ? { organization: env.KILO_ORGANIZATION_ID } : {}) });
  } catch { throw new ProviderError("credentials_invalid", `${QUOTA_PROVIDERS[id].name} has an invalid credential. Update Settings → Sources.`); }
}
async function smallFile(filename: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(filename, "r");
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > 65_536) throw new Error("Invalid credentials file");
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65_536) throw new Error("Invalid credentials file");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ProviderError("credentials_invalid", "The provider's local credential file could not be read.");
  } finally { await handle?.close(); }
}
