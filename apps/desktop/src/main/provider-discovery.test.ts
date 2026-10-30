import { describe, expect, it } from "vitest";
import type { DiscoveryResult } from "../engine/discovery";
import { summarizeDiscovery } from "./provider-discovery";

const result = (files: DiscoveryResult["files"]): DiscoveryResult => ({
  provider: "Claude Code",
  slug: "claude-code",
  route: "discovered",
  resolvedAt: 1,
  roots: [],
  scanned: ["/home/ada/.claude", "/home/ada/.config/claude"],
  related: ["/home/ada/.claude-backup"],
  directories: 2,
  entries: 41,
  files
});

describe("summarizeDiscovery", () => {
  it("turns the best file into the confidence shown beside the name", () => {
    const summary = summarizeDiscovery(result([
      {
        path: "/home/ada/.claude/usage.json",
        kind: "document",
        size: 2048,
        mtimeMs: 1,
        confidence: 0.92,
        matches: 14,
        reason: "token fields in usage",
        shape: { kind: "json", location: "usage.total_tokens", fields: ["input_tokens", "output_tokens"] }
      }
    ]));

    expect(summary).toMatchObject({
      provider: "Claude Code",
      route: "discovered",
      folders: 2,
      related: 1,
      entries: 41,
      confidence: 92
    });
    expect(summary.files[0]).toMatchObject({
      confidence: 92,
      matches: 14,
      store: "json · usage.total_tokens",
      fields: ["input_tokens", "output_tokens"]
    });
  });

  it("reports no store without inventing one", () => {
    const summary = summarizeDiscovery(result([]));
    expect(summary.files).toEqual([]);
    expect(summary.confidence).toBe(0);
  });

  it("caps the list so one huge provider cannot flood the page", () => {
    const files = Array.from({ length: 20 }, (_, index) => ({
      path: `/tmp/usage-${index}.json`,
      kind: "document" as const,
      size: 10,
      mtimeMs: index,
      confidence: 1 - index / 100,
      matches: 1,
      reason: "token fields"
    }));
    expect(summarizeDiscovery(result(files)).files).toHaveLength(12);
  });
});
