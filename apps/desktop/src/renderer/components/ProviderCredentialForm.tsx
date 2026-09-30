import { useState } from "react";
import { Button, Input } from "@heroui/react";
import { QUOTA_PROVIDERS, type QuotaProviderId } from "../../shared/quota-providers";

export function ProviderCredentialForm({ provider }: { provider: QuotaProviderId }): React.JSX.Element {
  const info = QUOTA_PROVIDERS[provider];
  const [secret, setSecret] = useState("");
  const [region, setRegion] = useState<"global" | "china">(provider === "kimi" ? "china" : "global");
  const [organization, setOrganization] = useState("");
  const [configured, setConfigured] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  async function load(): Promise<void> {
    setBusy(true); setError(null);
    try {
      const status = (await window.usageAtlas.getProviderCredentials())[provider];
      setConfigured(status.configured); setRegion(status.region); setOrganization(status.organization);
      setError(status.error ?? null); setLoaded(true);
    } catch { setError("Could not read the saved connection. Close and reopen this form to try again."); }
    finally { setBusy(false); }
  }
  async function save(remove: boolean): Promise<void> {
    setBusy(true); setError(null); setNotice(null);
    try {
      const status = (await window.usageAtlas.setProviderCredential(provider, remove ? null : {
        secret, ...(["kimi", "qoder"].includes(provider) ? { region } : {}), ...(provider === "kilo" ? { organization } : {})
      }))[provider];
      setConfigured(status.configured); setSecret("");
      setNotice(remove ? "Saved credential removed and source turned off." : "Credential saved. The connection status above shows the usage check result.");
    } catch { setSecret(""); setError("Could not save this connection. Check the credential and unlock your system keyring, then try again."); }
    finally { setBusy(false); }
  }
  return <details className="atlas-provider-connection mx-3 mb-3" onToggle={event => {
    if (event.currentTarget.open && !loaded && !busy) void load();
    if (!event.currentTarget.open) setSecret("");
  }}>
    <summary className="cursor-pointer py-2 text-xs">Connect {info.name}</summary>
    <form className="grid gap-3 rounded-xl border border-border p-4" onSubmit={event => { event.preventDefault(); void save(false); }}>
      <p className="text-xs text-muted">{info.help} Reads current allowances and balances. Token and request history are unavailable.</p>
      <label className="grid gap-1 text-xs">{info.credential}
        <Input aria-label={`${info.name} ${info.credential}`} autoComplete="off" disabled={busy || !loaded} maxLength={16384}
          onChange={event => setSecret(event.target.value)} placeholder={configured ? "Saved securely. Enter a replacement." : info.credential} type="password" value={secret} />
      </label>
      {["kimi", "qoder"].includes(provider) ? <label className="grid gap-1 text-xs">Credential region
        <select className="rounded-lg border border-border bg-surface p-2 text-foreground" disabled={busy} onChange={event => setRegion(event.target.value as "global" | "china")} value={region}>
          <option value="global">{provider === "kimi" ? "International · kimi.ai" : "Global · qoder.com"}</option>
          <option value="china">{provider === "kimi" ? "China · kimi.com" : "China · qoder.com.cn"}</option>
        </select>
      </label> : null}
      {provider === "kilo" ? <label className="grid gap-1 text-xs">Organization ID, optional
        <Input aria-label="Kilo organization ID" disabled={busy} maxLength={128} onChange={event => setOrganization(event.target.value)} placeholder="Leave empty for personal usage" value={organization} />
      </label> : null}
      <p className="text-xs text-muted">Credentials are encrypted on this device and excluded from cloud saves. You can also set {info.environment} before starting UsageAtlas.</p>
      <div className="flex flex-wrap gap-2">
        <Button isDisabled={!secret.trim() || busy || !loaded} type="submit" variant="secondary">Save and check</Button>
        {configured ? <Button isDisabled={busy} onPress={() => void save(true)} variant="ghost">Remove saved credential</Button> : null}
      </div>
      {error ? <p className="text-xs" role="alert">{error}</p> : null}
      <p className="text-xs text-muted" role="status">{busy ? "Working…" : notice}</p>
    </form>
  </details>;
}
