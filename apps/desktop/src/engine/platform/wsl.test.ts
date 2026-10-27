import { delimiter } from "node:path";
import { describe, expect, it } from "vitest";
import { listWslHomes, resolveScanHomes } from "./wsl";

interface Entry {
  name: string;
  isDirectory(): boolean;
}

function fakeReaddir(tree: Record<string, Entry[]>, calls: string[] = []) {
  return async (directory: string): Promise<Entry[]> => {
    calls.push(directory);
    const entries = tree[directory];
    if (!entries) {
      const error = new Error(`ENOENT: ${directory}`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return entries;
  };
}

const dir = (name: string): Entry => ({ name, isDirectory: () => true });
const file = (name: string): Entry => ({ name, isDirectory: () => false });

describe("WSL home discovery", () => {
  it("stays on the Windows home off Windows", async () => {
    const calls: string[] = [];
    expect(await listWslHomes({ platform: "linux", readdir: fakeReaddir({}, calls) })).toEqual([]);
    expect(calls).toEqual([]);
    expect(await resolveScanHomes("/home/user", { platform: "linux" })).toEqual(["/home/user"]);
  });

  it("collects user and root homes for every distribution", async () => {
    const homes = await listWslHomes({
      platform: "win32",
      environment: {},
      readdir: fakeReaddir({
        "\\\\wsl$": [dir("Ubuntu"), dir("Debian"), file("config")],
        "\\\\wsl$\\Ubuntu\\home": [dir("alice"), dir("bob")],
        "\\\\wsl$\\Ubuntu\\root": [dir(".cache")],
        "\\\\wsl$\\Debian\\root": [dir(".cache")]
      })
    });
    expect(homes).toEqual([
      "\\\\wsl$\\Ubuntu\\home\\alice",
      "\\\\wsl$\\Ubuntu\\home\\bob",
      "\\\\wsl$\\Ubuntu\\root",
      "\\\\wsl$\\Debian\\root"
    ]);
  });

  it("falls through to the next UNC root when the first has no usable homes", async () => {
    const homes = await listWslHomes({
      platform: "win32",
      environment: {},
      readdir: fakeReaddir({
        "\\\\wsl$": [file("stray")],
        "\\\\wsl.localhost": [dir("Ubuntu")],
        "\\\\wsl.localhost\\Ubuntu\\home": [dir("alice")]
      })
    });
    expect(homes).toEqual(["\\\\wsl.localhost\\Ubuntu\\home\\alice"]);
  });

  it("returns nothing when WSL cannot be read", async () => {
    expect(await listWslHomes({
      platform: "win32",
      environment: {},
      readdir: async () => { throw new Error("no WSL"); }
    })).toEqual([]);
  });

  it("bounds runaway distributions and users at exactly 32 homes", async () => {
    const distros = Array.from({ length: 20 }, (_, index) => dir(`distro-${index}`));
    const users = Array.from({ length: 20 }, (_, index) => dir(`user-${index}`));
    const tree: Record<string, Entry[]> = { "\\\\wsl$": distros };
    for (const distro of distros) tree[`\\\\wsl$\\${distro.name}\\home`] = users;
    const homes = await listWslHomes({ platform: "win32", environment: {}, readdir: fakeReaddir(tree) });
    expect(homes).toHaveLength(32);
    expect(homes[0]).toBe("\\\\wsl$\\distro-0\\home\\user-0");
    expect(homes[31]).toBe("\\\\wsl$\\distro-1\\home\\user-15");
  });

  it("honors an explicit home list on any platform", async () => {
    const calls: string[] = [];
    const homes = await listWslHomes({
      platform: "linux",
      environment: { USAGEATLAS_WSL_HOMES: `/mnt/wsl-a${delimiter}/mnt/wsl-b` },
      readdir: fakeReaddir({}, calls)
    });
    expect(homes).toEqual(["/mnt/wsl-a", "/mnt/wsl-b"]);
    expect(calls).toEqual([]);
  });

  it("opts out without touching the filesystem", async () => {
    const calls: string[] = [];
    expect(await listWslHomes({
      platform: "win32",
      environment: { USAGEATLAS_DISABLE_WSL: "1" },
      readdir: fakeReaddir({}, calls)
    })).toEqual([]);
    expect(calls).toEqual([]);
    expect(await resolveScanHomes("C:\\Users\\user", {
      platform: "win32",
      environment: { USAGEATLAS_DISABLE_WSL: "true", USAGEATLAS_WSL_HOMES: "\\\\wsl$\\Ubuntu\\home\\alice" }
    })).toEqual(["C:\\Users\\user"]);
  });

  it("keeps the primary home first and deduplicates", async () => {
    const homes = await resolveScanHomes("/primary", {
      platform: "linux",
      environment: { USAGEATLAS_WSL_HOMES: `/extra${delimiter}/primary` }
    });
    expect(homes).toEqual(["/primary", "/extra"]);
  });
});
