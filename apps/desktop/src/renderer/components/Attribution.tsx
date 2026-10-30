import { useMemo, useState } from "react";
import type { DashboardProvider } from "@usageatlas/contracts";
import { Button, Card } from "@heroui/react";
import type { DesktopPreferences } from "../../shared/desktop-api";
import {
  MAX_PLAN_TARGETS,
  OFFICIAL_PROVIDERS,
  isOfficialProvider,
  planWeight,
  type ReportPlan,
  type ReportTarget
} from "../../shared/report-plans";
import { defaultReportedModel, modelOptions } from "../../shared/report-models";
import { previewPlan } from "../../shared/report-wheel";

interface AttributionProps {
  providers: DashboardProvider[];
  preferences: DesktopPreferences | null;
  saving: boolean;
  onSave(plans: ReportPlan[]): Promise<void>;
}

const MAX_WEIGHT = 100;

/**
 * Cloud attribution: a source the server does not model yet can still be saved
 * under official providers. One source lists several targets with a share each —
 * 30 % Codex, 20 % ChatGPT, 50 % Claude, say — and each request spins the wheel,
 * so the uploaded traffic arrives as a mix instead of a single relabelled tool.
 * The local history is never rewritten: only the copy sent to the server is.
 */
export function Attribution({ providers, preferences, saving, onSave }: AttributionProps): React.JSX.Element {
  // The page follows saved preferences until the first edit here, so a rule written
  // on another page (or a reload) never discards a half-typed model.
  const [edited, setEdited] = useState<ReportPlan[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const draft = useMemo(() => edited ?? preferences?.reportPlans ?? [], [edited, preferences?.reportPlans]);

  const sources = providers.map(provider => ({ id: provider.id, name: provider.name }));
  const used = new Set<string>(draft.map(plan => plan.source));
  const available = sources.filter(source => !used.has(source.id));
  const invalid = draft.some(plan => !plan.targets.length || duplicateTarget(plan)
    || plan.targets.some(target => !target.model.trim() || !(target.weight >= 1 && target.weight <= MAX_WEIGHT)));
  // The token split each saved rule will reach, shown even before a save.
  const previews = useMemo(() => draft.map(plan => previewPlan(plan)), [draft]);
  const sourcesByID = new Map(sources.map(source => [source.id, source.name]));

  function edit(next: ReportPlan[]): void {
    setEdited(next);
    setStatus(null);
  }

  function patchPlan(index: number, value: Partial<ReportPlan>): void {
    edit(draft.map((plan, position) => (position === index ? { ...plan, ...value } : plan)));
  }

  function patchTarget(planIndex: number, targetIndex: number, value: Partial<ReportTarget>): void {
    patchPlan(planIndex, {
      targets: draft[planIndex].targets.map((target, position) => (position === targetIndex ? { ...target, ...value } : target))
    });
  }

  function addPlan(): void {
    const source = available[0];
    if (!source) return;
    edit([...draft, {
      source: source.id as ReportPlan["source"],
      targets: [{
        reportAs: OFFICIAL_PROVIDERS[0],
        model: defaultReportedModel(OFFICIAL_PROVIDERS[0]),
        weight: 100
      }]
    }]);
  }

  function removePlan(index: number): void {
    edit(draft.filter((_plan, position) => position !== index));
  }

  /** A new target starts with the share the plan has left, so one target stays 100 %. */
  function addTarget(planIndex: number): void {
    const plan = draft[planIndex];
    const taken = new Set(plan.targets.map(target => `${target.reportAs}\u0000${target.model}`));
    const reportAs = OFFICIAL_PROVIDERS.find(provider => {
      const model = defaultReportedModel(provider);
      return !taken.has(`${provider}\u0000${model}`);
    });
    if (!reportAs) return;
    const remaining = Math.max(1, MAX_WEIGHT - planWeight(plan) + plan.targets[0].weight);
    patchPlan(planIndex, {
      targets: [...plan.targets, { reportAs, model: defaultReportedModel(reportAs), weight: Math.min(MAX_WEIGHT, remaining) }]
    });
  }

  function removeTarget(planIndex: number, targetIndex: number): void {
    const plan = draft[planIndex];
    if (plan.targets.length === 1) return;
    patchPlan(planIndex, { targets: plan.targets.filter((_target, position) => position !== targetIndex) });
  }

  /** Provider change keeps the current model when the new provider offers it. */
  function changeProvider(planIndex: number, targetIndex: number, reportAs: ReportTarget["reportAs"], model: string): void {
    const offered = modelOptions(reportAs, "");
    patchTarget(planIndex, targetIndex, {
      reportAs,
      model: offered.includes(model) ? model : (offered[0] ?? defaultReportedModel(OFFICIAL_PROVIDERS[0]))
    });
  }

  /** Only an official provider has an offered catalog; anything else keeps its saved model. */
  function offeredModels(target: ReportTarget): readonly string[] {
    return isOfficialProvider(target.reportAs) ? modelOptions(target.reportAs, target.model) : [target.model];
  }

  async function save(): Promise<void> {
    setError(null);
    setStatus(null);
    try {
      await onSave(draft.map(plan => ({
        source: plan.source,
        targets: plan.targets.map(target => ({ ...target, model: target.model.trim() }))
      })));
      // The saved plans are the validated ones, so the page goes back to them.
      setEdited(null);
      setStatus("Rules saved. The next cloud save uses them.");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The rules could not be saved.");
    }
  }

  return (
    <div className="atlas-page atlas-page--narrow">
      <header className="atlas-page-header">
        <p className="atlas-kicker">Cloud</p>
        <h1 className="atlas-page-title">Attribution</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Choose how a source is reported to your account. Every source stays counted under its
          real name on this computer; only the copy saved to the cloud is relabelled. A source
          without its own rule follows the first mix on this page, so its usage can still be saved.
        </p>
      </header>

      <Card className="mt-6" variant="transparent">
        <Card.Header>
          <Card.Title>Report as</Card.Title>
          <Card.Description>
            A source the server does not know yet can be saved under official providers, with a share
            for each. The wheel weighs tokens, so a 30/20/50 split converges on those percentages over
            the days you track instead of following the number of requests.
          </Card.Description>
        </Card.Header>
        <Card.Content className="mt-3 space-y-4">
          {draft.length > 0 ? (
            <div className="atlas-plan-summary" aria-label="Saved attribution">
              <p className="text-xs text-muted">Currently reporting</p>
              {draft.map((plan) => (
                <p className="atlas-plan-summary__row" key={`summary-${plan.source}`}>
                  <strong>{sourcesByID.get(plan.source) ?? plan.source}</strong>
                  <span aria-hidden="true">→</span>
                  {plan.targets.map((target, targetIndex) => (
                    <span className="atlas-plan-summary__chip" key={`${target.reportAs}-${target.model}-${targetIndex}`}>
                      {target.reportAs} · {target.model}{" "}
                      <b>{Math.round(share(plan, target) * 100)}%</b>
                    </span>
                  ))}
                </p>
              ))}
            </div>
          ) : null}
          {draft.length === 0 ? (
            <p className="text-sm text-muted">
              No rule yet. Official sources save under their own name; a private source stays on this
              computer until you add a mix here.
            </p>
          ) : (
            draft.map((plan, planIndex) => (
              <div className="atlas-plan" key={`${plan.source}-${planIndex}`}>
                <div className="atlas-alias-row">
                  <label className="atlas-alias-field">
                    <span>Local source</span>
                    <select
                      aria-label="Local source"
                      onChange={(event) => patchPlan(planIndex, { source: event.target.value as ReportPlan["source"] })}
                      value={plan.source}
                    >
                      {[...sources.filter(source => source.id === plan.source), ...available].map(source => (
                        <option key={source.id} value={source.id}>{source.name}</option>
                      ))}
                    </select>
                  </label>
                  <p className="atlas-plan__summary text-xs text-muted">
                    {planWeight(plan)}% of this source&apos;s tokens, spread over {plan.targets.length}{" "}
                    {plan.targets.length === 1 ? "target" : "targets"}.
                  </p>
                  <Button
                    aria-label={`Remove the rule for ${plan.source}`}
                    className="ms-auto"
                    onPress={() => removePlan(planIndex)}
                    size="sm"
                    variant="ghost"
                  >
                    Remove
                  </Button>
                </div>

                {plan.targets.map((target, targetIndex) => (
                  <div className="atlas-alias-row" key={`${target.reportAs}-${target.model}-${targetIndex}`}>
                    <label className="atlas-alias-field">
                      <span>Reported as</span>
                      <select
                        aria-label="Reported provider"
                        onChange={(event) =>
                          changeProvider(planIndex, targetIndex, event.target.value as ReportTarget["reportAs"], target.model)
                        }
                        value={target.reportAs}
                      >
                        {OFFICIAL_PROVIDERS.map(provider => (
                          <option key={provider} value={provider}>{provider}</option>
                        ))}
                      </select>
                    </label>
                    <label className="atlas-alias-field atlas-alias-field--model">
                      <span>Model</span>
                      <select
                        aria-label="Reported model"
                        onChange={(event) => patchTarget(planIndex, targetIndex, { model: event.target.value })}
                        value={target.model}
                      >
                        {target.model ? null : <option value="">Choose a model…</option>}
                        {offeredModels(target).map((model) => (
                          <option key={model} value={model}>{model}</option>
                        ))}
                      </select>
                    </label>
                    <label className="atlas-alias-field atlas-alias-field--weight">
                      <span>Share</span>
                      <span className="atlas-weight-input">
                        <input
                          aria-label="Share of tokens"
                          max={MAX_WEIGHT}
                          min={1}
                          onChange={(event) =>
                            patchTarget(planIndex, targetIndex, { weight: Number.parseInt(event.target.value, 10) || 0 })
                          }
                          step={1}
                          type="number"
                          value={target.weight}
                        />
                        <span aria-hidden="true">%</span>
                      </span>
                    </label>
                    <span className="atlas-plan__share text-xs text-muted">
                      {Math.round(share(plan, target) * 100)}% of {plan.source}
                    </span>
                    <Button
                      aria-label={`Remove ${target.reportAs} from ${plan.source}`}
                      isDisabled={plan.targets.length === 1}
                      onPress={() => removeTarget(planIndex, targetIndex)}
                      size="sm"
                      variant="ghost"
                    >
                      Remove
                    </Button>
                  </div>
                ))}

                <div className="atlas-plan-preview">
                  <p className="text-xs text-muted">
                    These shares apply to token mass: each completed day or request is handed
                    to the provider furthest behind its percentage, so the profile&apos;s tool
                    totals end up at the split above — not at a count of requests.
                  </p>
                  <ul className="atlas-plan-preview__rows">
                    {previews[planIndex].targets.map((target) => (
                      <li key={`${target.reportAs}-${target.model}`}>
                        <span
                          aria-hidden="true"
                          className="atlas-plan-preview__bar"
                          style={{ width: `${Math.max(2, target.declared * 100)}%` }}
                        />
                        <span className="atlas-plan-preview__label">
                          {target.reportAs} · {target.model}
                        </span>
                        <span className="atlas-plan-preview__value">
                          {(target.declared * 100).toFixed(0)}% of tokens
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>

                <Button
                  isDisabled={plan.targets.length >= MAX_PLAN_TARGETS}
                  onPress={() => addTarget(planIndex)}
                  size="sm"
                  variant="outline"
                >
                  Add target
                </Button>
              </div>
            ))
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button isDisabled={available.length === 0} onPress={addPlan} size="sm" variant="outline">
              Add rule
            </Button>
            <Button isDisabled={saving || invalid || draft.length === 0} isPending={saving} onPress={() => void save()}>
              Save rules
            </Button>
            <span aria-live="polite" className="text-xs text-muted" role="status">
              {saving ? "Saving…" : status ?? ""}
            </span>
          </div>
          {invalid ? (
            <p className="text-xs text-danger" role="alert">
              Every target needs a provider, a model and a share between 1 % and {MAX_WEIGHT} %. Shares are
              relative, so 30 / 20 / 50 and 3 / 2 / 5 behave the same.
            </p>
          ) : null}
          {error ? (
            <p className="text-xs text-danger" role="alert">{error}</p>
          ) : null}
        </Card.Content>
      </Card>

      <Card className="mt-4" variant="transparent">
        <Card.Header>
          <Card.Title>What the server receives</Card.Title>
        </Card.Header>
        <Card.Content className="mt-2 space-y-2 text-sm text-muted">
          <p>
            With a rule of <strong>Freebuff → codex (gpt-5.3-codex) 30 %</strong> and{" "}
            <strong>claude (claude-sonnet-4-6) 70 %</strong>, this computer keeps counting Freebuff
            tokens, while the uploaded copies carry 30 % of the token mass under Codex and 70 % under
            Claude.
          </p>
          <p>
            Allocation follows the token deficit, not the request count: a day or request goes to the
            provider that is furthest behind its share, so a few huge requests cannot drag the
            breakdown away from the percentages above. A unit keeps its target when a save is retried.
          </p>
          <p>
            Restoring that account on another computer brings back what the server stored, so the relabelled
            copies reappear there. Unlabelled local history is never overwritten.
          </p>
        </Card.Content>
      </Card>
    </div>
  );
}

function share(plan: ReportPlan, target: ReportTarget): number {
  const total = planWeight(plan);
  return total > 0 ? target.weight / total : 0;
}

function duplicateTarget(plan: ReportPlan): boolean {
  const seen = new Set<string>();
  for (const target of plan.targets) {
    const key = `${target.reportAs}\u0000${target.model}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}
