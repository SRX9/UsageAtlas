const COMPACT_UNITS = [
  { threshold: 1_000_000_000_000, label: "T" },
  { threshold: 1_000_000_000, label: "B" },
  { threshold: 1_000_000, label: "M" },
  { threshold: 1_000, label: "K" }
] as const;

const decimalFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1
});

const exactNumberFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2
});

const currencyFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});

const preciseCurrencyFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4
});

export function formatCompactNumber(value: number): string {
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

export function formatCompactCurrency(value: number): string {
  const sign = value < 0 ? "-$" : "$";
  return `${sign}${formatCompactNumber(Math.abs(value))}`;
}

export function formatTokens(value: number): string {
  return `${formatCompactNumber(value)} tokens`;
}

export function formatExactTokens(value: number): string {
  return `${exactNumberFormatter.format(value)} tokens`;
}

export function formatCost(value: number | null): string {
  if (value === null) return "—";
  return value > 0 && value < 0.01 ? preciseCurrencyFormatter.format(value) : currencyFormatter.format(value);
}
