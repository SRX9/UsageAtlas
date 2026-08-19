import fixtureSnapshot from "@usageatlas/contracts/fixtures/dashboard-v2.json";
import type { DashboardSnapshot } from "@usageatlas/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { buildUsageInsights } from "../usage-insights";
import { ModelMixCard } from "./HeroMetrics";
import { ProviderMarks } from "./ProviderLogo";

const snapshot = fixtureSnapshot as unknown as DashboardSnapshot;

describe("ModelMixCard", () => {
  it("marks each model with its provider logo instead of a color swatch", () => {
    const html = renderToStaticMarkup(
      <ModelMixCard
        description="How each tool splits its tokens"
        emptyMessage="No models"
        mix={buildUsageInsights(snapshot, "all")}
      />
    );

    expect(html).toContain("gpt-5.6-sol");
    expect(html).toContain("atlas-provider-logo");
    expect(html).not.toContain("atlas-model-row__swatch");
  });
});

describe("ProviderMarks", () => {
  it("stacks logos when more than one tool used the model", () => {
    const html = renderToStaticMarkup(
      <ProviderMarks
        providers={[
          { id: "codex", name: "Codex" },
          { id: "claude", name: "Claude" },
          { id: "cursor", name: "Cursor" }
        ]}
      />
    );

    expect(html).toContain("atlas-provider-marks");
    expect(html.match(/atlas-provider-logo/gu)?.length).toBe(3);
  });
});
