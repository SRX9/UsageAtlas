import { safeStorage } from "electron";
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { EngineManager } from "./engine-manager";
import { isQuotaProvider, QUOTA_PROVIDERS, validateProviderCredential, type ProviderCredential, type ProviderCredentialStatus, type QuotaProviderId } from "../shared/quota-providers";

export async function configureProviderCredentials(store: Pick<ProviderCredentialStore, "read">, engine: Pick<EngineManager, "updateConfig">): Promise<void> {
  for (const id of Object.keys(QUOTA_PROVIDERS) as QuotaProviderId[]) {
    let credential: ProviderCredential | null = null;
    let credentialUnavailable = false;
    try { credential = store.read(id); } catch { credentialUnavailable = true; }
    await engine.updateConfig({ provider: id, credential: credential ? { ...credential } : null, credentialUnavailable });
  }
}

/** Secrets stay in the main/utility processes, outside preferences, telemetry, and cloud records. */
export class ProviderCredentialStore {
  constructor(private readonly directory: string) {}
  private secure(): void {
    if (!safeStorage.isEncryptionAvailable() || process.platform === "linux" && safeStorage.getSelectedStorageBackend() === "basic_text")
      throw new Error("Unlock your system keyring to save provider credentials securely.");
  }
  private filename(id: QuotaProviderId): string { return path.join(this.directory, `${id}.enc`); }
  read(id: QuotaProviderId): ProviderCredential | null {
    if (!isQuotaProvider(id)) throw new Error("Unsupported provider connection.");
    try {
      if (statSync(this.filename(id)).size > 65_536) throw new Error("Invalid file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("The saved provider connection could not be read. Save a new credential.", { cause: error });
    }
    this.secure();
    try { return validateProviderCredential(id, JSON.parse(safeStorage.decryptString(readFileSync(this.filename(id))))); }
    catch { throw new Error("The saved provider connection could not be opened. Save a new credential."); }
  }
  save(id: QuotaProviderId, value: ProviderCredential | null): void {
    const valid = validateProviderCredential(id, value);
    if (!valid) {
      try { unlinkSync(this.filename(id)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The saved provider credential could not be removed.", { cause: error }); }
      return;
    }
    this.secure();
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.filename(id)}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(valid)), { mode: 0o600, flag: "wx" });
      renameSync(temporary, this.filename(id));
    } finally {
      try { unlinkSync(temporary); } catch { /* rename already removed the temporary file */ }
    }
  }
  statuses(): Record<string, ProviderCredentialStatus> {
    return Object.fromEntries(Object.keys(QUOTA_PROVIDERS).map(key => {
      const id = key as QuotaProviderId;
      try {
        const value = this.read(id);
        return [id, { configured: Boolean(value), region: value?.region ?? (id === "kimi" ? "china" : "global"), organization: value?.organization ?? "" }];
      } catch (error) {
        return [id, { configured: false, region: id === "kimi" ? "china" : "global", organization: "", error: error instanceof Error ? error.message : "Could not read credential." }];
      }
    }));
  }
}
