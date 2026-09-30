export const QUOTA_PROVIDERS = {
  warp: { name: "Warp", credential: "API key", environment: "WARP_API_KEY", help: "Create an API key in Warp settings." },
  kimi: { name: "Kimi Code", credential: "Coding API key", environment: "KIMI_CODE_API_KEY", help: "Use a Kimi Code key from the console for the selected region." },
  kilo: { name: "Kilo Code", credential: "API key", environment: "KILO_API_KEY", help: "Use a Kilo key, or sign in with kilo auth login." },
  copilot: { name: "GitHub Copilot", credential: "GitHub OAuth token", environment: "COPILOT_GITHUB_TOKEN", help: "Use a Copilot-authorized GitHub OAuth token. Generic fine-grained PATs may not have access." },
  factory: { name: "Factory / Droid", credential: "API key", environment: "FACTORY_API_KEY", help: "Create an API key in Factory settings. The local .factory/.env file is also supported." },
  amp: { name: "Amp", credential: "Access token", environment: "AMP_API_KEY", help: "Create an access token in Amp settings." },
  qoder: { name: "Qoder", credential: "Session cookie", environment: "QODER_COOKIE", help: "Copy the Cookie header from your Qoder account usage request. Select its site below." }
} as const;

export type QuotaProviderId = keyof typeof QUOTA_PROVIDERS;
export interface ProviderCredential {
  secret: string;
  region?: "global" | "china";
  organization?: string;
}
export interface ProviderCredentialStatus {
  error?: string;
  configured: boolean;
  region: "global" | "china";
  organization: string;
}
export function isQuotaProvider(value: unknown): value is QuotaProviderId {
  return typeof value === "string" && Object.hasOwn(QUOTA_PROVIDERS, value);
}

/** Never accepts URLs or request captures: credentials are bound to allowlisted origins. */
export function validateProviderCredential(id: unknown, value: unknown): ProviderCredential | null {
  if (!isQuotaProvider(id)) throw new Error("Unsupported provider connection.");
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid provider connection.");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["secret", "region", "organization"].includes(k))) throw new Error("Invalid provider connection.");
  if (typeof v.secret !== "string" || !v.secret.trim() || v.secret.length > 16_384 || /[\r\n\0]/u.test(v.secret))
    throw new Error("Enter a single API key, token, or Cookie header value.");
  const secret = v.secret.trim().replace(id === "qoder" ? /^Cookie:\s*/iu : /^Bearer\s+/iu, "");
  if (!secret || (id === "qoder" ? !/^[^=;\s]+=.+/u.test(secret) : /\s/u.test(secret))) throw new Error("Invalid credential format.");
  if (v.region !== undefined && v.region !== "china" && v.region !== "global") throw new Error("Invalid provider region.");
  if (v.organization !== undefined && (id !== "kilo" || typeof v.organization !== "string" || !/^[a-zA-Z0-9_-]{0,128}$/u.test(v.organization)))
    throw new Error("Invalid Kilo organization ID.");
  return { secret, ...(v.region ? { region: v.region as "china" | "global" } : {}),
    ...(v.organization ? { organization: v.organization as string } : {}) };
}
