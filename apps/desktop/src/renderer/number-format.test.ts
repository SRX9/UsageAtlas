import { afterEach, describe, expect, it } from "vitest";
import {
  formatAxisNumber,
  formatCompactCurrency,
  formatCompactNumber,
  formatExactTokens,
  formatTokens,
  setNumberStyle
} from "./number-format";

afterEach(() => setNumberStyle("exact"));

describe("number formatting", () => {
  it("prints every digit by default", () => {
    expect(formatCompactNumber(1_250_000)).toBe("1,250,000");
    expect(formatCompactNumber(2_000_000_000)).toBe("2,000,000,000");
    expect(formatTokens(1_284_930)).toBe("1,284,930 tokens");
  });

  it("keeps small values concise in both styles", () => {
    expect(formatCompactNumber(42)).toBe("42");
    expect(formatTokens(720)).toBe("720 tokens");
  });

  it("shortens figures when the appearance setting asks for it", () => {
    setNumberStyle("compact");
    expect(formatCompactNumber(1_250_000)).toBe("1.3M");
    expect(formatCompactNumber(2_000_000_000)).toBe("2B");
    expect(formatCompactNumber(14_100_000_000)).toBe("14.1B");
    expect(formatCompactNumber(12_500)).toBe("12.5K");
    expect(formatCompactNumber(999_999)).toBe("1M");
    expect(formatCompactNumber(42)).toBe("42");
  });

  it("always keeps chart axes compact, whatever the preference says", () => {
    expect(formatAxisNumber(1_250_000)).toBe("1.3M");
    setNumberStyle("compact");
    expect(formatAxisNumber(1_250_000)).toBe("1.3M");
  });

  it("uses compact units for chart currency", () => {
    expect(formatCompactCurrency(9_436.72)).toBe("$9,436.72");
    setNumberStyle("compact");
    expect(formatCompactCurrency(9_436.72)).toBe("$9.4K");
    expect(formatCompactCurrency(2_000_000)).toBe("$2M");
    expect(formatCompactCurrency(-1_250)).toBe("-$1.3K");
  });

  it("can expose the full value where detail is available on demand", () => {
    expect(formatExactTokens(1_250_000)).toBe("1,250,000 tokens");
  });
});
