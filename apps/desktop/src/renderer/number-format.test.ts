import { describe, expect, it } from "vitest";
import {
  formatCompactCurrency,
  formatCompactNumber,
  formatExactTokens,
  formatTokens
} from "./number-format";

describe("number formatting", () => {
  it("uses short units without insignificant zeroes", () => {
    expect(formatCompactNumber(1_250_000)).toBe("1.3M");
    expect(formatCompactNumber(2_000_000_000)).toBe("2B");
    expect(formatCompactNumber(14_100_000_000)).toBe("14.1B");
    expect(formatCompactNumber(12_500)).toBe("12.5K");
    expect(formatCompactNumber(999_999)).toBe("1M");
  });

  it("keeps small values concise", () => {
    expect(formatCompactNumber(42)).toBe("42");
    expect(formatTokens(720)).toBe("720 tokens");
  });

  it("uses compact units for chart currency", () => {
    expect(formatCompactCurrency(9_436.72)).toBe("$9.4K");
    expect(formatCompactCurrency(2_000_000)).toBe("$2M");
    expect(formatCompactCurrency(-1_250)).toBe("-$1.3K");
  });

  it("can expose the full value where detail is available on demand", () => {
    expect(formatExactTokens(1_250_000)).toBe("1,250,000 tokens");
  });
});
