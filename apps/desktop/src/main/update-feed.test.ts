import { describe, expect, it } from "vitest";
import {
  compareVersions,
  isNewerVersion,
  latestPublishedVersion,
  redactUpdateError,
  squirrelFeedURL
} from "./update-feed";

describe("squirrelFeedURL", () => {
  it("puts the installed version in the macOS feed path so the edge can answer 204", () => {
    expect(squirrelFeedURL("darwin", "arm64", "0.2.2"))
      .toBe("https://updates.usageatlas.com/darwin/arm64/0.2.2");
  });

  it("keeps the Windows feed a bare directory for the RELEASES lookup", () => {
    expect(squirrelFeedURL("win32", "x64", "0.2.2")).toBe("https://updates.usageatlas.com/win32/x64");
  });

  it("has no Squirrel feed for platforms without an installer", () => {
    expect(squirrelFeedURL("linux", "x64", "0.2.2")).toBeNull();
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

  it("rejects payloads that are not a release summary", () => {
    expect(latestPublishedVersion(null)).toBeNull();
    expect(latestPublishedVersion({})).toBeNull();
    expect(latestPublishedVersion({ version: 3 })).toBeNull();
    expect(latestPublishedVersion({ version: "latest" })).toBeNull();
  });
});

describe("redactUpdateError", () => {
  it("keeps release URLs out of local logs", () => {
    expect(redactUpdateError("failed to fetch https://updates.usageatlas.com/darwin/arm64/0.2.2"))
      .toBe("failed to fetch [update-url]");
  });
});
