/**
 * A provider is only known by its name, so the first job is spelling it the way
 * an installer would have written it on disk: `CodeFree`, `code-free`,
 * `codefree-desktop` and `freebuff Desktop` are all the same destination.
 */

const SUFFIXES = ["", "-desktop", "-cli", "-app", "-desktop-app", "-client", "-companion"];

export interface NameVariants {
  /** The name exactly as the user typed it. */
  name: string;
  /** Normalised folder spelling: lowercase, hyphenated. */
  slug: string;
  /** Every folder spelling worth trying. */
  variants: string[];
}

export function nameVariants(name: string): NameVariants {
  const trimmed = name.trim();
  const slug = compactSlug(trimmed);
  const spellings = new Set<string>();
  for (const base of [slug, slug.replace(/-/g, ""), trimmed, trimmed.toLowerCase()]) {
    if (base.length < 2) continue;
    for (const suffix of SUFFIXES) spellings.add(`${base}${suffix}`);
  }
  if (slug) spellings.add(slug.replace(/-/g, "_"));
  return { name: trimmed, slug, variants: [...spellings] };
}

/** Lowercase, punctuation collapsed to single hyphens. */
export function compactSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Folder names are compared with case and punctuation removed: `z.ai` ~ `zai`. */
export function compactName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/**
 * What an installer appends to a product name: `codefree` ships as
 * `codefree-desktop` or `CodeFree Studio`. Anything else (`Code` for `codefree`)
 * is a different product that merely shares a prefix.
 */
const PRODUCT_SUFFIXES = new Set([
  "desktop", "cli", "app", "client", "companion", "studio", "pro", "beta",
  "dev", "nightly", "electron", "gui", "agent", "code", "ai"
]);

/**
 * True when two folder names plausibly describe the same product: equal, or one
 * is the other plus a product suffix. `code` never matches `codefree`.
 */
export function namesRelated(left: string, right: string): boolean {
  const first = compactName(left);
  const second = compactName(right);
  if (!first || !second) return false;
  if (first === second) return true;
  const [longer, shorter] = first.length >= second.length ? [first, second] : [second, first];
  if (shorter.length < 3 || !longer.startsWith(shorter)) return false;
  return PRODUCT_SUFFIXES.has(longer.slice(shorter.length));
}
