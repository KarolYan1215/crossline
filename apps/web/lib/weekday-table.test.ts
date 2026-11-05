import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { weekdayTable } from "./conversation";

describe("weekdayTable", () => {
  it("names this week's and next week's days from a Tuesday (W-192)", () => {
    const table = weekdayTable(new Date("2026-11-03T22:00:00-06:00"), "America/Chicago");
    expect(table.startsWith("本周二 11-03（今天）、本周三 11-04、本周四 11-05")).toBe(true);
    expect(table).toContain("本周日 11-08、下周一 11-09");
    expect(table).toContain("下下周一 11-16");
  });
});
