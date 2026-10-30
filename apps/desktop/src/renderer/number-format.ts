import type { CurrencyCode, NumberStyle } from "../shared/desktop-api";

/**
 * Numbers are rendered in English on purpose: every label around them is English
 * ("1,284,930 tokens", "48.8M"), and following the operating system's locale
 * instead would put French or German separators inside English copy. Keeping the
 * locale explicit also keeps the figures identical on every machine.
 */
const NUMBER_LOCALE = "en";

/**
 * Settings → Appearance picks between every digit and a short unit. The choice
 * lives here rather than in each call site so a figure cannot disagree with the
 * one next to it; charts ask for `formatAxisNumber` and always stay compact.
 */
let numberStyle: NumberStyle = "exact";

export function setNumberStyle(style: NumberStyle): void {
  numberStyle = style;
}

const COMPACT_UNITS = [
  { threshold: 1_000_000_000_000, label: "T" },
  { threshold: 1_000_000_000, label: "B" },
  { threshold: 1_000_000, label: "M" },
  { threshold: 1_000, label: "K" }
] as const;

const decimalFormatter = new Intl.NumberFormat(NUMBER_LOCALE, {
  maximumFractionDigits: 1
});

const exactIntegerFormatter = new Intl.NumberFormat(NUMBER_LOCALE, {
  maximumFractionDigits: 0
});

const exactDecimalFormatter = new Intl.NumberFormat(NUMBER_LOCALE, {
  maximumFractionDigits: 2
});

const exactNumberFormatter = new Intl.NumberFormat(NUMBER_LOCALE, {
  maximumFractionDigits: 2
});

/**
 * Costs are stored in USD and converted for display. The rate is fixed by the
 * user rather than fetched, so a figure never changes between two renders.
 */
let costCurrency: CurrencyCode = "USD";
let costRate = 1;
let costTaxPercent = 0;
const currencyFormatters = new Map<string, Intl.NumberFormat>();

export interface CostDisplaySettings {
  currency: CurrencyCode;
  /** Display-currency units per USD. */
  rate: number;
  taxPercent: number;
}

export function setCostDisplay(settings: CostDisplaySettings): void {
  costCurrency = settings.currency;
  costRate = Number.isFinite(settings.rate) && settings.rate > 0 ? settings.rate : 1;
  costTaxPercent = Number.isFinite(settings.taxPercent) ? Math.min(100, Math.max(0, settings.taxPercent)) : 0;
  currencyFormatters.clear();
}

function convertedCost(value: number): number {
  return value * costRate * (1 + costTaxPercent / 100);
}

function currencyFormatter(precise: boolean): Intl.NumberFormat {
  const digits = costCurrency === "JPY" ? 0 : precise ? 4 : 2;
  const key = `${costCurrency}:${digits}`;
  let formatter = currencyFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(NUMBER_LOCALE, {
      style: "currency",
      currency: costCurrency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    });
    currencyFormatters.set(key, formatter);
  }
  return formatter;
}

function currencySymbol(): string {
  const parts = currencyFormatter(false).formatToParts(0);
  return parts.find((part) => part.type === "currency")?.value ?? "$";
}

/** Every digit, grouped — the form the interface uses unless compact is chosen. */
function formatExactValue(value: number): string {
  return (Number.isInteger(value) ? exactIntegerFormatter : exactDecimalFormatter).format(value);
}

function formatWithUnits(value: number): string {
  const unitIndex = COMPACT_UNITS.findIndex(({ threshold }) => Math.abs(value) >= threshold);
  if (unitIndex === -1) return decimalFormatter.format(value);

  let unit = COMPACT_UNITS[unitIndex];
  let scaledValue = value / unit.threshold;
  if (unitIndex > 0 && Math.abs(Math.round(scaledValue * 10) / 10) >= 1_000) {
    unit = COMPACT_UNITS[unitIndex - 1];
    scaledValue = value / unit.threshold;
  }

  return `${decimalFormatter.format(scaledValue)}${unit.label}`;
}

/** Respects the Appearance choice: exact digits, or a short unit like `1.3M`. */
export function formatCompactNumber(value: number): string {
  return numberStyle === "exact" ? formatExactValue(value) : formatWithUnits(value);
}

/** Every digit, regardless of the Appearance choice. */
export function formatExactNumber(value: number): string {
  return formatExactValue(value);
}

/** A short unit such as `1.3M`, regardless of the Appearance choice. */
export function formatShortNumber(value: number): string {
  return formatWithUnits(value);
}

/**
 * Chart ticks stay compact whatever the preference says: at 1,284,930, 1,140,000
 * and 1,024,000 the axis labels would collide and leave no room for the plot.
 */
export function formatAxisNumber(value: number): string {
  return formatWithUnits(value);
}

export function formatCompactCurrency(value: number): string {
  const converted = convertedCost(value);
  const sign = converted < 0 ? `-${currencySymbol()}` : currencySymbol();
  return `${sign}${formatCompactNumber(Math.abs(converted))}`;
}

/** Chart currency ticks stay short for the same reason the numeric ones do. */
export function formatAxisCurrency(value: number): string {
  const converted = convertedCost(value);
  const sign = converted < 0 ? `-${currencySymbol()}` : currencySymbol();
  return `${sign}${formatWithUnits(Math.abs(converted))}`;
}

export function formatTokens(value: number): string {
  return `${formatCompactNumber(value)} tokens`;
}

export function formatExactTokens(value: number): string {
  return `${exactNumberFormatter.format(value)} tokens`;
}

export function formatCost(value: number | null): string {
  if (value === null) return "—";
  const converted = convertedCost(value);
  return converted > 0 && converted < 0.01
    ? currencyFormatter(true).format(converted)
    : currencyFormatter(false).format(converted);
}
