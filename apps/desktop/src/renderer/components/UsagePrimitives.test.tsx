import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState, KPI, TrendChip } from "./UsagePrimitives";

describe("UsagePrimitives", () => {
  it("renders a semantic KPI section", () => {
    const html = renderToStaticMarkup(
      <KPI className="atlas-stat">
        <KPI.Header><KPI.Title>Requests</KPI.Title></KPI.Header>
        <KPI.Content>42</KPI.Content>
      </KPI>
    );

    expect(html).toContain('<section class="usage-kpi atlas-stat">');
    expect(html).toContain('<h2 class="usage-kpi__title">Requests</h2>');
    expect(html).toContain('<div class="usage-kpi__content">42</div>');
  });

  it("keeps trend direction visible without relying on color", () => {
    const html = renderToStaticMarkup(
      <TrendChip trend="down" variant="tertiary">
        -8%<TrendChip.Suffix>vs prior</TrendChip.Suffix>
      </TrendChip>
    );

    expect(html).toContain('data-trend="down"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("-8%");
    expect(html).toContain("vs prior");
  });

  it("renders empty-state copy as a heading and description", () => {
    const html = renderToStaticMarkup(
      <EmptyState size="lg">
        <EmptyState.Header>
          <EmptyState.Media variant="icon">!</EmptyState.Media>
          <EmptyState.Title>Nothing here</EmptyState.Title>
          <EmptyState.Description>Try again later.</EmptyState.Description>
        </EmptyState.Header>
      </EmptyState>
    );

    expect(html).toContain('<h2 class="usage-empty-state__title">Nothing here</h2>');
    expect(html).toContain('<p class="usage-empty-state__description">Try again later.</p>');
  });
});
