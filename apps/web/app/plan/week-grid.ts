import type { AvailabilityWindow } from "@crossline/core";

/**
 * The weekly availability as a grid the person paints: seven rows (0 = Sunday, as `AvailabilityWindow.days`), 48 half hours, each
 * cell 0 (not available) or 1–3 (available, with low / medium / high energy). Converting back merges a day's runs of one energy into a
 * window and gives days with the same run one window, so a painted grid saves as few windows as it can. Pure, tested without a page.
 */
export type WeekGrid = number[][];
export const SLOTS = 48;
const ENERGY = ["low", "medium", "high"] as const;
const level = { low: 1, medium: 2, high: 3 } as const;
const clock = (slot: number) => `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`;
const slotOf = (time: string, round: "floor" | "ceil") => {
  const [h, m] = time.split(":").map(Number);
  const minutes = h! * 60 + m!;
  return Math.min(SLOTS, Math.max(0, round === "floor" ? Math.floor(minutes / 30) : Math.ceil(minutes / 30)));
};

export function gridFromWindows(windows: AvailabilityWindow[]): WeekGrid {
  const grid = Array.from({ length: 7 }, () => Array.from({ length: SLOTS }, () => 0));
  for (const window of windows) {
    const end = window.end === "24:00" ? SLOTS : slotOf(window.end, "ceil");
    for (const day of window.days) for (let slot = slotOf(window.start, "floor"); slot < end; slot += 1) grid[day]![slot] = level[window.energy];
  }
  return grid;
}

export function windowsFromGrid(grid: WeekGrid): AvailabilityWindow[] {
  const runs = new Map<string, number[]>();
  grid.forEach((row, day) => {
    let slot = 0;
    while (slot < SLOTS) {
      const value = row[slot] ?? 0;
      if (!value) { slot += 1; continue; }
      let end = slot;
      while (end < SLOTS && row[end] === value) end += 1;
      const key = `${slot}|${end}|${value}`;
      runs.set(key, [...(runs.get(key) ?? []), day]);
      slot = end;
    }
  });
  return [...runs].map(([key, days]) => {
    const [start, end, value] = key.split("|").map(Number);
    return { days, start: clock(start!), end: end === SLOTS ? "23:59" : clock(end!), energy: ENERGY[value! - 1]! };
  }).sort((a, b) => a.start.localeCompare(b.start) || a.days[0]! - b.days[0]!);
}

/** Hours a week a grid offers. */
export const gridHours = (grid: WeekGrid) => grid.reduce((sum, row) => sum + row.filter(Boolean).length, 0) / 2;
