import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("./crossline", () => ({
  effectiveSchedulePreferences: () => ({ preferences: { timeZone: "America/Chicago" } }),
  toZonedInstant: (day: string, time: string) => `${day}T${time}:00.000Z`,
  loadCurrentPlan: async () => ({
    status: "approved",
    blocks: [
      { id: "scheduled:research-starter-work-order", title: "示例", day: "2099-01-01", start: "09:00", end: "10:00" },
      { id: "scheduled:real-order-1", title: "真实任务", day: "2099-01-01", start: "11:00", end: "12:00" },
      { id: "graph_calendar:abc", title: "上课", day: "2099-01-01", start: "14:00", end: "15:00" }
    ]
  })
}));

import { blocksToPublish } from "./calendar-publish";

describe("blocksToPublish", () => {
  it("publishes only the scheduler's blocks for real work orders, never the seeded demo orders or the person's own calendar", async () => {
    const result = await blocksToPublish({} as never, new Date("2098-01-01T00:00:00Z"));
    expect(result.approved).toBe(true);
    expect(result.blocks.map((block) => block.id)).toEqual(["scheduled:real-order-1"]);
  });
});
