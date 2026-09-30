import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { DashboardProvider } from "@usageatlas/contracts";
import { QuotaDetails } from "./QuotaDetails";
import { ProviderCredentialForm } from "./ProviderCredentialForm";
const provider: DashboardProvider = { id: "copilot", name: "GitHub Copilot", source: "provider_quota", enabled: true, analytics: null, windows: [], quotaMetrics: [
  { id: "seat", label: "Seat credits", unit: "credits", used: 31, limit: null, remaining: null, resetAt: null }
] };
describe("quota UI", () => {
  it("displays allowance-less usage without implying a free or unlimited plan", () => {
    expect(renderToStaticMarkup(<QuotaDetails providers={[provider]} />)).toContain("31 credits used · allowance not reported");
    expect(renderToStaticMarkup(<QuotaDetails providers={[{ ...provider, error: { code: "auth_required", message: "Sign in", retryable: false } }]} />)).toBe("");
  });
  it("renders a masked connection form and explicit regional choices", () => {
    const html = renderToStaticMarkup(<ProviderCredentialForm provider="qoder" />);
    expect(html).toContain('type="password"'); expect(html).toContain("qoder.com.cn");
    expect(html).toContain("excluded from cloud saves");
  });
});
