import type { DashboardProvider } from "@usageatlas/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { LimitsPreviewCard } from "./CapacityMeters";

const provider = {
  id: "freebuff",
  name: "Freebuff",
  enabled: true,
  source: "local",
  windows: [],
  identity: null,
  credits: null,
  error: null,
  updatedAt: null,
  analytics: {
    today: { totalTokens: 1_234_567, estimatedCostUSD: 0.87 }
  }
} as unknown as DashboardProvider;

describe("LimitsPreviewCard", () => {
  it("lists active tools that report no quota window", () => {
    const html = renderToStaticMarkup(
      <LimitsPreviewCard limitOrder={[]} onOpenAll={vi.fn()} providers={[provider]} />
    );

    expect(html).toContain("Active tool capacity");
    expect(html).toContain("Freebuff");
    expect(html).toContain("No quota reported");
    expect(html).toContain("View all");
  });
});
