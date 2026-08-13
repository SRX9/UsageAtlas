import ClaudeCode from "@lobehub/icons/es/ClaudeCode/components/Color.js";
import Codex from "@lobehub/icons/es/Codex/components/Color.js";
import Cursor from "@lobehub/icons/es/Cursor/components/Mono.js";
import OpenCode from "@lobehub/icons/es/OpenCode/components/Mono.js";

interface ProviderLogoProps {
  providerID: string;
  providerName: string;
  compact?: boolean;
  mini?: boolean;
}

export function ProviderLogo({
  providerID,
  providerName,
  compact = false,
  mini = false
}: ProviderLogoProps): React.JSX.Element {
  const Icon = providerID === "codex"
    ? Codex
    : providerID === "claude"
      ? ClaudeCode
      : providerID === "cursor"
        ? Cursor
        : providerID === "opencode"
          ? OpenCode
          : null;
  const avatarClassName = mini ? "size-9 text-sm" : compact ? "size-12 text-base" : "size-16 text-xl";
  const iconSize = mini ? 22 : compact ? 27 : 32;

  return (
    <span aria-hidden="true" className={`atlas-provider-logo ${avatarClassName}`}>
      {Icon ? <Icon size={iconSize} /> : providerName.slice(0, 1)}
    </span>
  );
}
