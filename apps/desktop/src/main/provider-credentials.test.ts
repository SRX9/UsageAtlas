import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderCredentialStore, configureProviderCredentials } from "./provider-credentials";
import { QUOTA_PROVIDERS, type QuotaProviderId } from "../shared/quota-providers";
import { EngineService } from "../engine/engine-service";
import { quotaAdapter, metric, reading } from "../engine/providers/quota-shared";
import { validateDashboard } from "./dashboard-validation";
const state = vi.hoisted(() => ({ available: true }));
vi.mock("electron", () => ({ safeStorage: {
  isEncryptionAvailable: () => state.available, getSelectedStorageBackend: () => "test-keyring",
  encryptString: (s: string) => Buffer.from(Buffer.from(s).toString("base64")),
  decryptString: (b: Buffer) => Buffer.from(b.toString(), "base64").toString()
} }));
const directories: string[] = [];
afterEach(() => { state.available = true; for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() { const d = mkdtempSync(path.join(tmpdir(), "quota-vault-")); directories.push(d); return { d, store: new ProviderCredentialStore(d) }; }
describe("encrypted provider credential store", () => {
  it.each(["damaged", "locked"])("blocks automatic account fallback when a saved connection is %s and recovers after removal", async failure => {
    const { d, store } = setup();
    store.save("warp", { secret: "saved-account" });
    if (failure === "locked") state.available = false;
    else writeFileSync(path.join(d, "warp.enc"), "broken");
    const fetched: string[] = [];
    const adapters = (Object.keys(QUOTA_PROVIDERS) as QuotaProviderId[]).map(id => quotaAdapter(id, async credential => {
      fetched.push(`${id}:${credential.secret}`);
      return reading(id, [metric("plan", "Credits", "credits", 40, 100)]);
    }, { homeDirectory: d, environment: { WARP_API_KEY: "environment-account", KIMI_CODE_API_KEY: "independent-account" } }));
    const engine = new EngineService(adapters);
    const configure = () => configureProviderCredentials(store, { async updateConfig(params) {
      const result = await engine.handle({ id: "config", method: "config.update", params });
      if (!result.ok) throw new Error(result.error?.message);
      return result.result!;
    } });
    await configure();
    const reply = await engine.handle({ id: "refresh", method: "snapshot.get", params: { force: true } });
    expect(validateDashboard(reply.result!).providers.find(p => p.id === "warp"))
      .toMatchObject({ enabled: true, windows: [], quotaMetrics: [], error: { code: "credentials_invalid" } });
    expect(fetched).toEqual(["kimi:independent-account"]);
    state.available = true;
    store.save("warp", null);
    await configure();
    await engine.handle({ id: "recovered", method: "snapshot.get", params: { force: true } });
    expect(fetched).toContain("warp:environment-account");
  });
  it("uses encryption, exposes metadata only, and supports replacement/removal", () => {
    const { d, store } = setup();
    store.save("qoder", { secret: "session=private-cookie", region: "china" });
    expect(readFileSync(path.join(d, "qoder.enc")).toString()).not.toContain("private-cookie");
    expect(store.read("qoder")).toMatchObject({ secret: "session=private-cookie", region: "china" });
    expect(JSON.stringify(store.statuses())).not.toContain("private-cookie");
    store.save("qoder", { secret: "session=replacement", region: "global" });
    expect(store.read("qoder")?.region).toBe("global");
    store.save("qoder", null); expect(store.read("qoder")).toBeNull();
  });
  it("refuses plaintext fallback and isolates damaged saved credentials", () => {
    const { d, store } = setup(); state.available = false;
    expect(() => store.save("warp", { secret: "private-token" })).toThrow("keyring");
    state.available = true; store.save("warp", { secret: "private-token" });
    writeFileSync(path.join(d, "qoder.enc"), "broken");
    expect(store.statuses().qoder.error).toContain("could not be opened");
    expect(store.statuses().warp.configured).toBe(true);
  });
});
