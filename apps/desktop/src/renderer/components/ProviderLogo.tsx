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
import ZAI from "@lobehub/icons/es/ZAI/components/Mono.js";
import GeminiCLI from "@lobehub/icons/es/GeminiCLI/components/Color.js";
import Qwen from "@lobehub/icons/es/Qwen/components/Color.js";
import Cline from "@lobehub/icons/es/Cline/components/Mono.js";
import RooCode from "@lobehub/icons/es/RooCode/components/Mono.js";

import { createElement } from "react";
import { PROVIDER_ICONS } from "../provider-icons";

const warpLogo = new URL("../assets/providers/warp.svg", import.meta.url).href;
const factoryLogo = new URL("../assets/providers/factory.svg", import.meta.url).href;
const freebuffLogo = new URL("../assets/providers/freebuff.svg", import.meta.url).href;

/** Catalog spellings are compared the way the icon generator writes them. */
function iconKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

export function providerIconFor(name: string): (typeof PROVIDER_ICONS)[string] | null {
  return PROVIDER_ICONS[iconKey(name)] ?? null;
}

/** The mark shown in the provider directory, before a tool is even added. */
const DIRECTORY_IMAGES: Record<string, string> = {
  warp: warpLogo,
  factory: factoryLogo,
  "factory droid": factoryLogo,
  freebuff: freebuffLogo
};

export function ProviderDirectoryLogo({ name, size = 30 }: { name: string; size?: number }): React.JSX.Element {
  const Icon = providerIconFor(name);
  const image = DIRECTORY_IMAGES[iconKey(name)];
  return (
    <span aria-hidden="true" className="atlas-provider-logo atlas-provider-logo--directory">
      {Icon ? createElement(Icon, { size })
        : image ? <img alt="" height={size} src={image} width={size} />
          : name.trim().slice(0, 1).toUpperCase()}
    </span>
  );
}

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
                : providerID === "copilot" ? GithubCopilot : providerID === "amp" ? Amp
                  : providerID === "qoder" ? Qoder : providerID === "zai" ? ZAI
                    : providerID === "gemini" ? GeminiCLI : providerID === "qwen" ? Qwen
                      : providerID === "cline" ? Cline : providerID === "roo" ? RooCode : null;
  const avatarClassName = mark
    ? "size-[18px] text-[10px]"
    : mini
      ? "size-9 text-sm"
      : compact
        ? "size-12 text-base"
        : "size-16 text-xl";
  const iconSize = mark ? 16 : mini ? 22 : compact ? 27 : 32;
  const image = providerID === "warp" ? warpLogo
    : providerID === "factory" ? factoryLogo
      : providerID === "freebuff" ? freebuffLogo
        : null;
  // Newer catalog tools have no hand-written branch above; the generated
  // registry covers them by product name, then by adapter id.
  const DirectoryIcon = providerIconFor(providerName) ?? providerIconFor(providerID);

  return (
    <span
      aria-hidden="true"
      className={`atlas-provider-logo ${avatarClassName}`}
      style={{ background: `color-mix(in oklab, var(--atlas-provider-${providerID}, transparent) 12%, transparent)` }}
    >
      {Icon ? <Icon size={iconSize} />
        : image ? <img alt="" height={iconSize} src={image} width={iconSize} />
          : DirectoryIcon ? createElement(DirectoryIcon, { size: iconSize })
            : providerID === "pi" ? "π" : providerName.slice(0, 1)}
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
