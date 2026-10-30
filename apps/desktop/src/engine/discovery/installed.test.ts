import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanInstalledTools } from "./installed";

const roots: string[] = [];

async function home(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "usageatlas-installed-"));
  roots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Only the home directory is offered, so the test never sees the real machine. */
function options(homeDirectory: string): { homeDirectory: string; environment: NodeJS.ProcessEnv } {
  return { homeDirectory, environment: {} };
}

describe("scanInstalledTools", () => {
  it("reports a catalog tool whose own folder exists", async () => {
    const directory = await home();
    await mkdir(path.join(directory, ".config", "aider"), { recursive: true });
    const found = await scanInstalledTools(options(directory));
    expect(found.map((tool) => tool.name)).toContain("Aider");
    expect(found.find((tool) => tool.name === "Aider")?.folder)
      .toBe(path.join(directory, ".config", "aider"));
  });

  it("recognises an alias folder, not only the catalog spelling", async () => {
    const directory = await home();
    await mkdir(path.join(directory, ".config", "claude"), { recursive: true });
    const found = await scanInstalledTools(options(directory));
    expect(found.map((tool) => tool.name)).toContain("Claude Code");
  });

  it("does not report a file as an installed tool", async () => {
    const directory = await home();
    await mkdir(path.join(directory, ".config"), { recursive: true });
    await writeFile(path.join(directory, ".config", "cursor"), "not a folder");
    const found = await scanInstalledTools(options(directory));
    expect(found.map((tool) => tool.name)).not.toContain("Cursor");
  });

  it("comes back empty on a profile with no tool folders", async () => {
    const directory = await home();
    await mkdir(path.join(directory, ".config"), { recursive: true });
    expect(await scanInstalledTools(options(directory))).toEqual([]);
  });

  it("reads the catalog once per tool and stays sorted", async () => {
    const directory = await home();
    await mkdir(path.join(directory, ".config", "cursor"), { recursive: true });
    await mkdir(path.join(directory, ".config", "aider"), { recursive: true });
    const found = await scanInstalledTools(options(directory));
    const names = found.map((tool) => tool.name);
    expect(names).toEqual([...names].sort((left, right) => left.localeCompare(right)));
    expect(new Set(names).size).toBe(names.length);
  });
});
