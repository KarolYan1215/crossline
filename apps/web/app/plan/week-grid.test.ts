import { describe, expect, it } from "vitest";
import { gridFromWindows, gridHours, windowsFromGrid } from "./week-grid";

describe("week grid", () => {
  it("round-trips windows, merging days with the same run into one window", () => {
    const windows = [{ days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", energy: "high" as const },
      { days: [0, 6], start: "10:30", end: "12:00", energy: "low" as const }];
    const grid = gridFromWindows(windows);
    expect(gridHours(grid)).toBe(5 * 3 + 2 * 1.5);
    expect(windowsFromGrid(grid)).toEqual([{ days: [1, 2, 3, 4, 5], start: "09:00", end: "12:00", energy: "high" },
      { days: [0, 6], start: "10:30", end: "12:00", energy: "low" }]);
  });

  it("splits a day where the energy changes and keeps a run to midnight valid", () => {
    const grid = gridFromWindows([]);
    for (let slot = 18; slot < 22; slot += 1) grid[2]![slot] = 3;
    for (let slot = 22; slot < 24; slot += 1) grid[2]![slot] = 1;
    for (let slot = 44; slot < 48; slot += 1) grid[2]![slot] = 2;
    expect(windowsFromGrid(grid)).toEqual([{ days: [2], start: "09:00", end: "11:00", energy: "high" },
      { days: [2], start: "11:00", end: "12:00", energy: "low" }, { days: [2], start: "22:00", end: "23:59", energy: "medium" }]);
    expect(gridFromWindows(windowsFromGrid(grid))).toEqual(grid);
  });
});
