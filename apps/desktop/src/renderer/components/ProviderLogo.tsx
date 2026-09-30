import ClaudeCode from "@lobehub/icons/es/ClaudeCode/components/Color.js";
import Codex from "@lobehub/icons/es/Codex/components/Color.js";
import Cursor from "@lobehub/icons/es/Cursor/components/Mono.js";
import OpenCode from "@lobehub/icons/es/OpenCode/components/Mono.js";
import Antigravity from "@lobehub/icons/es/Antigravity/components/Color.js";
import Meta from "@lobehub/icons/es/Meta/components/Color.js";
import Kimi from "@lobehub/icons/es/Kimi/components/Color.js";
import KiloCode from "@lobehub/icons/es/KiloCode/components/Mono.js";
import GithubCopilot from "@lobehub/icons/es/GithubCopilot/components/Mono.js";
import Amp from "@lobehub/icons/es/Amp/components/Color.js";
import Qoder from "@lobehub/icons/es/Qoder/components/Color.js";

const warpLogo = new URL("../assets/providers/warp.svg", import.meta.url).href;
const factoryLogo = new URL("../assets/providers/factory.svg", import.meta.url).href;

interface ProviderLogoProps {
  providerID: string;
  providerName: string;
  compact?: boolean;
  mini?: boolean;
  /** 16px mark for legends and list rows that used to use a color dot. */
  mark?: boolean;
}

interface ProviderMark {
  id: string;
  name: string;
}

export function ProviderLogo({
  providerID,
  providerName,
  compact = false,
  mini = false,
  mark = false
}: ProviderLogoProps): React.JSX.Element {
  const Icon = providerID === "codex"
    ? Codex
    : providerID === "claude"
      ? ClaudeCode
      : providerID === "cursor"
        ? Cursor
        : providerID === "opencode"
          ? OpenCode
          : providerID === "antigravity"
            ? Antigravity
            : providerID === "muse"
              ? Meta
              : providerID === "kimi" ? Kimi : providerID === "kilo" ? KiloCode
                : providerID === "copilot" ? GithubCopilot : providerID === "amp" ? Amp : providerID === "qoder" ? Qoder : null;
  const avatarClassName = mark
    ? "size-[18px] text-[10px]"
    : mini
      ? "size-9 text-sm"
      : compact
        ? "size-12 text-base"
        : "size-16 text-xl";
  const iconSize = mark ? 16 : mini ? 22 : compact ? 27 : 32;
  const image = providerID === "warp" ? warpLogo : providerID === "factory" ? factoryLogo : null;

  return (
    <span aria-hidden="true" className={`atlas-provider-logo ${avatarClassName}`}>
      {Icon ? <Icon size={iconSize} /> : image ? <img alt="" height={iconSize} src={image} width={iconSize} /> : providerID === "pi" ? "π" : providerName.slice(0, 1)}
    </span>
  );
}

/** One logo, or overlapping logos when a model was used from more than one tool. */
export function ProviderMarks({ providers }: { providers: ProviderMark[] }): React.JSX.Element {
  const marks = uniqueProviders(providers);
  if (marks.length === 0) return <span aria-hidden="true" className="atlas-provider-marks" />;
  if (marks.length === 1) {
    const provider = marks[0];
    return <ProviderLogo mark providerID={provider.id} providerName={provider.name} />;
  }

  return (
    <span aria-hidden="true" className="atlas-provider-marks">
      {marks.map((provider) => (
        <ProviderLogo key={provider.id} mark providerID={provider.id} providerName={provider.name} />
      ))}
    </span>
  );
}

function uniqueProviders(providers: ProviderMark[]): ProviderMark[] {
  const seen = new Set<string>();
  const marks: ProviderMark[] = [];
  for (const provider of providers) {
    if (seen.has(provider.id)) continue;
    seen.add(provider.id);
    marks.push(provider);
  }
  return marks;
}
