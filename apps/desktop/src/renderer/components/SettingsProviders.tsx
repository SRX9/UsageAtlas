import { Button, Card, Spinner } from "@heroui/react";
import { useEffect, useMemo, useState } from "react";
import type { ProviderDirectoryEntry } from "../../shared/desktop-api";
import { useI18n } from "../i18n";
import type { MessageKey } from "../i18n";
import { CheckIcon, RefreshIcon } from "../icons";
import { ProviderDirectoryLogo } from "./ProviderLogo";

type Filter = "all" | "trackable" | "on" | "detected";
const FILTERS: Filter[] = ["all", "trackable", "on", "detected"];
const PAGE_SIZE = 60;

interface ProbeState {
  busy: boolean;
  files: number | null;
  folders: number;
}

/**
 * Settings → Providers. The catalog is the whole directory of tools the app
 * knows, searchable by name; the cards say which ones have a reader, which ones
 * live on this computer, and which ones are on. Nothing here is auto-enabled:
 * the switch is the only thing that turns a tool on, and scanning is passive.
 */
export function SettingsProviders({
  onSetProviderEnabled
}: {
  onSetProviderEnabled(providerID: string, enabled: boolean): Promise<void>;
}): React.JSX.Element {
  const { t } = useI18n();
  const [entries, setEntries] = useState<ProviderDirectoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [probes, setProbes] = useState<Record<string, ProbeState>>({});

  useEffect(() => {
    let active = true;
    void window.usageAtlas.getProviderDirectory()
      .then((directory) => {
        if (active) setEntries(directory);
      })
      .catch(() => {
        if (active) setEntries([]);
      });
    return () => {
      active = false;
    };
  }, []);

  const stats = useMemo(() => {
    const all = entries ?? [];
    return {
      total: all.length,
      trackable: all.filter((entry) => entry.adapter).length,
      detected: all.filter((entry) => entry.installedFolder).length
    };
  }, [entries]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (entries ?? [])
      .filter((entry) => {
        if (filter === "trackable" && !entry.adapter) return false;
        if (filter === "on" && !(entry.adapter && entry.tracked)) return false;
        if (filter === "detected" && !entry.installedFolder) return false;
        return !needle || entry.name.toLowerCase().includes(needle);
      })
      .sort((left, right) => {
        // What is already on the computer and readable comes first; the rest is
        // alphabetical so search is predictable.
        const rank = (entry: ProviderDirectoryEntry): number =>
          (entry.installedFolder ? 0 : 2) + (entry.adapter ? 0 : 1);
        return rank(left) - rank(right) || left.name.localeCompare(right.name);
      });
  }, [entries, filter, query]);

  async function toggle(entry: ProviderDirectoryEntry): Promise<void> {
    if (!entry.adapter || busy) return;
    setBusy(entry.adapter);
    const next = !entry.tracked;
    try {
      await onSetProviderEnabled(entry.adapter, next);
      setEntries((current) => current?.map((row) => (
        row.name === entry.name ? { ...row, tracked: next } : row
      )) ?? current);
    } finally {
      setBusy(null);
    }
  }

  async function probe(entry: ProviderDirectoryEntry): Promise<void> {
    if (probes[entry.name]?.busy) return;
    setProbes((current) => ({ ...current, [entry.name]: { busy: true, files: null, folders: 0 } }));
    try {
      const result = await window.usageAtlas.discoverProvider(entry.name);
      setProbes((current) => ({
        ...current,
        [entry.name]: { busy: false, files: result.files.length, folders: result.folders }
      }));
    } catch {
      setProbes((current) => ({ ...current, [entry.name]: { busy: false, files: null, folders: 0 } }));
    }
  }

  return (
    <Card variant="transparent">
      <Card.Header>
        <Card.Title>{t("settings.providers.title")}</Card.Title>
        <Card.Description>{t("settings.providers.description")}</Card.Description>
      </Card.Header>
      <Card.Content className="mt-3">
        <div className="atlas-providers__toolbar">
          <input
            aria-label={t("settings.providers.search")}
            className="atlas-text-field atlas-providers__search"
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(PAGE_SIZE);
            }}
            placeholder={t("settings.providers.placeholder")}
            spellCheck={false}
            value={query}
          />
          <div aria-label={t("settings.providers.filterLabel")} className="atlas-providers__filters" role="group">
            {FILTERS.map((option) => (
              <button
                aria-pressed={filter === option}
                className="atlas-providers__chip"
                key={option}
                onClick={() => {
                  setFilter(option);
                  setLimit(PAGE_SIZE);
                }}
                type="button"
              >
                {t(`settings.providers.filter.${option}` as MessageKey)}
              </button>
            ))}
          </div>
        </div>

        <p className="atlas-providers__count" role="status">
          {t("settings.providers.count", { count: stats.total })}
          <span aria-hidden="true"> · </span>
          {t("settings.providers.trackable", { count: stats.trackable })}
          <span aria-hidden="true"> · </span>
          {t("settings.providers.detected", { count: stats.detected })}
        </p>

        {entries === null ? (
          <div className="atlas-providers__loading">
            <Spinner size="sm" />
            <span>{t("settings.providers.loading")}</span>
          </div>
        ) : visible.length === 0 ? (
          <p className="atlas-discovery__empty">{t("settings.providers.empty")}</p>
        ) : (
          <>
            <ul className="atlas-providers__grid">
              {visible.slice(0, limit).map((entry) => {
                const state = probes[entry.name];
                return (
                  <li className="atlas-provider-card" key={entry.name}>
                    <div className="atlas-provider-card__head">
                      <ProviderDirectoryLogo name={entry.name} />
                      <div className="atlas-provider-card__title">
                        <strong title={entry.name}>{entry.name}</strong>
                        <span>{t(`settings.providers.kind.${entry.kind}` as MessageKey)}</span>
                      </div>
                      {entry.installedFolder ? (
                        <span
                          className="atlas-provider-card__badge"
                          title={entry.installedFolder}
                        >
                          {t("settings.providers.detectedBadge")}
                        </span>
                      ) : null}
                    </div>

                    {entry.adapter ? (
                      <Button
                        className="atlas-provider-card__action"
                        isDisabled={busy === entry.adapter}
                        onPress={() => void toggle(entry)}
                        variant={entry.tracked ? "secondary" : "outline"}
                      >
                        {busy === entry.adapter ? <Spinner size="sm" /> : null}
                        {entry.tracked ? <CheckIcon className="size-4" /> : null}
                        <span>
                          {t(entry.tracked ? "settings.providers.enabled" : "settings.providers.enable")}
                        </span>
                      </Button>
                    ) : (
                      <div className="atlas-provider-card__unsupported">
                        <span className="atlas-provider-card__note">{t("settings.providers.readerMissing")}</span>
                        <Button
                          isDisabled={state?.busy === true}
                          onPress={() => void probe(entry)}
                          variant="outline"
                        >
                          {state?.busy ? <RefreshIcon className="size-4 animate-spin" /> : null}
                          <span>
                            {t(state?.busy ? "settings.providers.probing" : "settings.providers.probe")}
                          </span>
                        </Button>
                        {state && !state.busy ? (
                          <span className="atlas-provider-card__note" role="status">
                            {state.files === null
                              ? t("settings.providers.probeFailed")
                              : state.files === 0
                                ? t("settings.providers.probeNone")
                                : t("settings.providers.probeFound", { count: state.files, folders: state.folders })}
                          </span>
                        ) : null}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {visible.length > limit ? (
              <Button className="mt-3" onPress={() => setLimit((current) => current + PAGE_SIZE)} variant="ghost">
                {t("settings.providers.showMore", { count: visible.length - limit })}
              </Button>
            ) : null}
          </>
        )}

        <p className="atlas-providers__note">{t("settings.providers.note")}</p>
      </Card.Content>
    </Card>
  );
}
