import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveQuotaCredential } from "./quota-credentials";
import { validateProviderCredential } from "../../shared/quota-providers";
const directories: string[] = [];
afterEach(async () => { for (const d of directories.splice(0)) await rm(d, { recursive: true, force: true }); });
describe("quota credentials", () => {
  it("reads only the supported local Kilo and Factory credentials", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "quota-creds-")); directories.push(home);
    await mkdir(path.join(home, ".local/share/kilo"), { recursive: true }); await mkdir(path.join(home, ".factory"));
    await writeFile(path.join(home, ".local/share/kilo/auth.json"), JSON.stringify({ kilo: { access: "local-kilo" }, other: { access: "wrong" } }));
    await writeFile(path.join(home, ".factory/.env"), 'OTHER=wrong\nexport FACTORY_API_KEY="local-factory"\n');
    const options = { homeDirectory: home, environment: {} };
    expect((await resolveQuotaCredential("kilo", options))?.secret).toBe("local-kilo");
    expect((await resolveQuotaCredential("factory", options))?.secret).toBe("local-factory");
    expect((await resolveQuotaCredential("factory", { ...options, environment: { FACTORY_API_KEY: "explicit" } }))?.secret).toBe("explicit");
    await writeFile(path.join(home, ".local/share/kilo/auth.json"), "{".repeat(100_000));
    await expect(resolveQuotaCredential("kilo", options)).rejects.toMatchObject({ code: "credentials_invalid" });
  });
  it("rejects header injection, arbitrary endpoints, and unsupported providers", () => {
    for (const value of [{ secret: "key\r\nHost: bad" }, { secret: "key", region: "other" }, { secret: "key", url: "https://bad" }])
      expect(() => validateProviderCredential("warp", value)).toThrow();
    expect(() => validateProviderCredential("../copilot", { secret: "key" })).toThrow();
    expect(validateProviderCredential("qoder", { secret: "Cookie: session=abc; other=def", region: "china" })).toEqual({ secret: "session=abc; other=def", region: "china" });
  });
});
