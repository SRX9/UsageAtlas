import type { DashboardProvider, QuotaMetric } from "@usageatlas/contracts";
import { ProviderLogo } from "./ProviderLogo";

export function QuotaDetails({ providers }: { providers: DashboardProvider[] }): React.JSX.Element | null {
  const visible = providers.filter(p => p.enabled && !p.error && p.quotaMetrics?.length);
  if (!visible.length) return null;
  return <section className="mt-8" aria-labelledby="quota-details-heading">
    <h2 className="text-base font-medium" id="quota-details-heading">Reported allowances and balances</h2>
    <p className="mt-1 text-xs text-muted">Current provider counters. These are separate from token history and estimated costs.</p>
    <div className="mt-4 grid gap-4">
      {visible.map(provider => <div className="rounded-xl border border-border p-4" key={provider.id}>
        <h3 className="flex items-center gap-2 text-sm font-medium"><ProviderLogo mark providerID={provider.id} providerName={provider.name} />{provider.name}</h3>
        <dl className="mt-3 grid gap-2 text-xs">
          {provider.quotaMetrics!.map(m => <div className="flex flex-wrap justify-between gap-x-4 gap-y-1" key={m.id}>
            <dt className="text-muted">{m.label}</dt><dd>{formatQuotaMetric(m)}</dd>
          </div>)}
        </dl>
      </div>)}
    </div>
  </section>;
}
function formatQuotaMetric(m: QuotaMetric): string {
  const fmt = (n: number) => m.unit === "USD" ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(n)
    : `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n)}${m.unit === "percent" ? "%" : ` ${m.unit}`}`;
  if (m.used !== null && m.limit !== null) return `${fmt(m.used)} of ${fmt(m.limit)} used`;
  if (m.remaining !== null) return `${fmt(m.remaining)} remaining`;
  return m.used !== null ? `${fmt(m.used)} used · allowance not reported` : "Not reported";
}
