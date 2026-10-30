import { Button, Card } from "@heroui/react";
import { useEffect, useId, useState } from "react";
import type { InstalledProvider, ProviderDiscovery as Discovery } from "../../shared/desktop-api";
import { useI18n } from "../i18n";
import { RefreshIcon } from "../icons";

/**
 * Settings → Find a provider. The scan is local: it walks the folders a tool of
 * that name usually owns, probes candidates for token fields, and reports the
 * route it would read. Nothing leaves the computer.
 */
export function ProviderDiscovery(): React.JSX.Element {
  const { t } = useI18n();
  const listId = useId().replace(/:/gu, "");
  const [name, setName] = useState("");
  const [catalog, setCatalog] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Discovery | null>(null);
  const [error, setError] = useState(false);
  const [installed, setInstalled] = useState<InstalledProvider[] | null>(null);
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    let active = true;
    void window.usageAtlas.listDiscoverableProviders()
      .then((names) => {
        if (active) setCatalog(names);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await probe(name.trim());
  }

  async function probe(provider: string): Promise<void> {
    if (!provider || busy) return;
    setName(provider);
    setBusy(true);
    setError(false);
    try {
      setResult(await window.usageAtlas.discoverProvider(provider));
    } catch {
      setResult(null);
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  async function scan(): Promise<void> {
    if (scanning) return;
    setScanning(true);
    try {
      setInstalled(await window.usageAtlas.scanInstalledProviders());
    } catch {
      setInstalled([]);
    } finally {
      setScanning(false);
    }
  }

  return (
    <Card variant="transparent">
      <Card.Header>
        <Card.Title>{t("settings.discovery.title")}</Card.Title>
        <Card.Description>{t("settings.discovery.description")}</Card.Description>
      </Card.Header>
      <Card.Content className="mt-2">
        <form className="atlas-discovery__form" onSubmit={(event) => void submit(event)}>
          <input
            aria-label={t("settings.discovery.title")}
            className="atlas-text-field"
            disabled={busy}
            list={listId}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("settings.discovery.placeholder")}
            spellCheck={false}
            value={name}
          />
          <datalist id={listId}>
            {catalog.map((entry) => <option key={entry} value={entry} />)}
          </datalist>
          <Button isDisabled={busy || !name.trim()} type="submit" variant="secondary">
            {busy ? <RefreshIcon className="size-4 animate-spin" /> : null}
            <span>{t(busy ? "settings.discovery.searching" : "settings.discovery.search")}</span>
          </Button>
          <Button isDisabled={scanning} onPress={() => void scan()} variant="outline">
            {scanning ? <RefreshIcon className="size-4 animate-spin" /> : null}
            <span>{t(scanning ? "settings.discovery.scanning" : "settings.discovery.scan")}</span>
          </Button>
        </form>

        {installed ? (
          <div className="atlas-discovery__installed" role="status">
            {installed.length === 0 ? (
              <p className="atlas-discovery__empty">{t("settings.discovery.installedNone")}</p>
            ) : (
              <>
                <p className="atlas-discovery__meta">
                  {t("settings.discovery.installed", { count: installed.length })}
                </p>
                <ul className="atlas-discovery__chips">
                  {installed.map((tool) => (
                    <li key={tool.name}>
                      <button
                        className="atlas-discovery__chip"
                        disabled={busy}
                        onClick={() => void probe(tool.name)}
                        title={tool.folder}
                        type="button"
                      >
                        {tool.name}
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        ) : null}

        {error ? (
          <p className="atlas-discovery__error" role="alert">{t("settings.discovery.error")}</p>
        ) : null}

        {result ? (
          <div className="atlas-discovery__result" role="status">
            <div className="atlas-discovery__summary">
              <strong>{result.provider}</strong>
              <span className="atlas-discovery__badge" data-route={result.route}>
                {t(result.route === "cached" ? "settings.discovery.remembered" : "settings.discovery.found")}
              </span>
              <span className="atlas-discovery__confidence">
                {t("settings.discovery.confidence", { percent: result.confidence })}
              </span>
              {result.confirmedBy > 0 ? (
                <span className="atlas-discovery__confidence">
                  {t("settings.discovery.confirmed", { count: result.confirmedBy })}
                </span>
              ) : null}
            </div>
            <p className="atlas-discovery__meta">
              {t("settings.discovery.scanned", { folders: result.folders, entries: result.entries })}
            </p>
            {result.files.length === 0 ? (
              <p className="atlas-discovery__empty">{t("settings.discovery.none")}</p>
            ) : (
              <ul className="atlas-discovery__files">
                {result.files.map((file) => (
                  <li key={file.path}>
                    <span className="atlas-discovery__path" title={file.path}>{file.path}</span>
                    <span className="atlas-discovery__detail">
                      {file.store ?? file.kind} · {t("settings.discovery.confidence", { percent: file.confidence })}
                      {file.fields.length > 0 ? ` · ${file.fields.join(", ")}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </Card.Content>
    </Card>
  );
}
