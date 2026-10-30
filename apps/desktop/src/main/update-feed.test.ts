import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareVersions,
  downloadPageURL,
  isNewerVersion,
  latestPublishedVersion,
  newerInstalledVersion,
  previousInstalledVersion,
  redactUpdateError,
  resolveUpdateSource,
  squirrelFeedURL,
  updateCheckURL,
  versionFromReleaseTag
} from "./update-feed";

const fork = resolveUpdateSource("fork");
const upstream = resolveUpdateSource("upstream");
const custom = resolveUpdateSource("custom", "arthur/UsageAtlas-Builds");

describe("squirrelFeedURL", () => {
  it("puts the installed version in the macOS feed path so the edge can answer 204", () => {
    expect(squirrelFeedURL("darwin", "arm64", "0.2.2", upstream))
      .toBe("https://updates.usageatlas.com/darwin/arm64/0.2.2");
  });

  it("keeps the Windows feed a bare directory for the RELEASES lookup", () => {
    expect(squirrelFeedURL("win32", "x64", "0.2.2", upstream))
      .toBe("https://updates.usageatlas.com/win32/x64");
  });

  it("defaults to the mirror, so an updater without a source is unchanged", () => {
    expect(squirrelFeedURL("win32", "x64", "0.2.2")).toBe("https://updates.usageatlas.com/win32/x64");
  });

  it("feeds Windows from the fork's GitHub releases, where Squirrel finds RELEASES", () => {
    expect(squirrelFeedURL("win32", "x64", "0.3.1", fork))
      .toBe("https://github.com/Artleboss2/UsageAtlas-Unofficial/releases/latest/download");
  });

  it("has no Squirrel feed for platforms without an installer", () => {
    expect(squirrelFeedURL("linux", "x64", "0.2.2")).toBeNull();
    // GitHub cannot express the versioned macOS path the mirror uses.
    expect(squirrelFeedURL("darwin", "arm64", "0.2.2", fork)).toBeNull();
  });
});

describe("update sources", () => {
  it("polls GitHub on the fork and the project mirror upstream", () => {
    expect(updateCheckURL(upstream)).toBe("https://updates.usageatlas.com/latest.json");
    expect(updateCheckURL(fork))
      .toBe("https://api.github.com/repos/Artleboss2/UsageAtlas-Unofficial/releases/latest");
  });

  it("sends a manual download to the publisher that offers it", () => {
    expect(downloadPageURL(upstream)).toBe("https://usageatlas.com/#download");
    expect(downloadPageURL(fork))
      .toBe("https://github.com/Artleboss2/UsageAtlas-Unofficial/releases/latest");
  });

  it("reads the releases of a repository the user names", () => {
    expect(custom.repository).toBe("arthur/UsageAtlas-Builds");
    expect(squirrelFeedURL("win32", "x64", "0.3.3", custom))
      .toBe("https://github.com/arthur/UsageAtlas-Builds/releases/latest/download");
    expect(updateCheckURL(custom)).toBe("https://api.github.com/repos/arthur/UsageAtlas-Builds/releases/latest");
    expect(downloadPageURL(custom)).toBe("https://github.com/arthur/UsageAtlas-Builds/releases/latest");
  });

  it("falls back to this fork's releases while the repository field is empty", () => {
    expect(resolveUpdateSource("custom", "").repository).toBe("Artleboss2/UsageAtlas-Unofficial");
  });

  it("keeps an unknown publisher on the fork's releases", () => {
    expect(resolveUpdateSource("nonsense" as never)).toEqual({ channel: "fork", repository: "Artleboss2/UsageAtlas-Unofficial" });
  });
});

describe("versionFromReleaseTag", () => {
  it("reads the version out of the tags both publishers use", () => {
    expect(versionFromReleaseTag("desktop-v0.3.1")).toBe("0.3.1");
    expect(versionFromReleaseTag("v0.2.17")).toBe("0.2.17");
    expect(versionFromReleaseTag("0.3.0-rc.1")).toBe("0.3.0-rc.1");
  });

  it("rejects a tag without a version", () => {
    expect(versionFromReleaseTag("nightly")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by numeric precedence rather than string order", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  it("ranks a prerelease below its final build", () => {
    expect(compareVersions("0.3.0", "0.3.0-rc.1")).toBe(1);
    expect(compareVersions("0.3.0-rc.1", "0.3.0-rc.2")).toBe(-1);
    expect(compareVersions("0.3.0-beta.1", "0.3.0-rc.1")).toBe(-1);
  });

  it("reports whether a published build supersedes the installed one", () => {
    expect(isNewerVersion("0.3.0", "0.2.2")).toBe(true);
    expect(isNewerVersion("0.2.2", "0.2.2")).toBe(false);
    expect(isNewerVersion("0.2.1", "0.2.2")).toBe(false);
  });
});

describe("latestPublishedVersion", () => {
  it("reads the version from the published release summary", () => {
    expect(latestPublishedVersion({ version: "0.3.0", downloads: [] })).toBe("0.3.0");
  });

  it("reads the GitHub release tag a fork publishes", () => {
    expect(latestPublishedVersion({ tag_name: "desktop-v0.3.1" })).toBe("0.3.1");
  });

  it("rejects payloads that are not a release summary", () => {
    expect(latestPublishedVersion(null)).toBeNull();
    expect(latestPublishedVersion({})).toBeNull();
    expect(latestPublishedVersion({ version: 3 })).toBeNull();
    expect(latestPublishedVersion({ version: "latest" })).toBeNull();
  });
});

describe("newerInstalledVersion", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  /** Builds the `app-<version>` folders Squirrel leaves under the install root. */
  function install(...versions: string[]): string {
    const root = mkdtempSync(path.join(tmpdir(), "usageatlas-install-"));
    roots.push(root);
    for (const version of versions) mkdirSync(path.join(root, `app-${version}`));
    return root;
  }

  it("reports a build that is already unpacked while an older window runs", () => {
    const root = install("0.3.4", "0.3.5", "0.3.6");
    expect(newerInstalledVersion(path.join(root, "app-0.3.5", "UsageAtlas.exe"), "0.3.5")).toBe("0.3.6");
  });

  it("stays quiet when the running build is the newest one", () => {
    const root = install("0.3.5", "0.3.6");
    expect(newerInstalledVersion(path.join(root, "app-0.3.6", "UsageAtlas.exe"), "0.3.6")).toBeNull();
  });

  it("ignores paths that are not a Squirrel install", () => {
    const root = install("0.3.6");
    expect(newerInstalledVersion(path.join(root, "UsageAtlas.exe"), "0.3.5")).toBeNull();
  });

  it("offers the newest older build as the rollback target", () => {
    const root = install("0.3.5", "0.3.6", "0.3.9");
    expect(previousInstalledVersion(path.join(root, "app-0.3.9", "UsageAtlas.exe"), "0.3.9")).toBe("0.3.6");
    expect(previousInstalledVersion(path.join(root, "app-0.3.5", "UsageAtlas.exe"), "0.3.5")).toBeNull();
  });
});

describe("redactUpdateError", () => {
  it("keeps release URLs out of local logs", () => {
    expect(redactUpdateError("failed to fetch https://updates.usageatlas.com/darwin/arm64/0.2.2"))
      .toBe("failed to fetch [update-url]");
  });
});
