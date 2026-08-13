import { describe, expect, it } from "vitest";
import { formatHourOfDay } from "./time-format";

describe("formatHourOfDay", () => {
  it.each([
    [0, "12am"],
    [6, "6am"],
    [12, "12pm"],
    [18, "6pm"],
    [23, "11pm"]
  ])("formats hour %i with a full day period", (hour, expected) => {
    expect(formatHourOfDay(hour)).toBe(expected);
  });
});