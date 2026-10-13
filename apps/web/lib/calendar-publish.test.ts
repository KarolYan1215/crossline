import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const store = {
  listWaitingItems: () => [{ id: "wait-1", who: "师兄", title: "真实测量数据", followUpAt: "2099-01-08", state: "open" }],
  listMilestones: () => [{ id: "m1", status: "approved", title: "西湖合作论文已投出" }, { id: "m2", status: "draft", title: "草稿" }],
  listMilestoneAnchors: () => [{ milestoneId: "m1", deadline: "2099-01-31" }, { milestoneId: "m2", deadline: "2099-01-20" }]
};
vi.mock("./crossline", () => ({
  getStore: () => store,
  planToday: () => "2099-01-01",
  effectiveSchedulePreferences: () => ({ preferences: { timeZone: "America/Chicago" } }),
  toZonedInstant: (day: string, time: string) => `${day}T${time}:00.000Z`,
  loadCurrentPlan: async () => ({
    blocks: [
      { id: "scheduled:research-starter-work-order", title: "示例", day: "2099-01-01", start: "09:00", end: "10:00" },
      { id: "scheduled:real-order-1", title: "真实任务", day: "2099-01-01", start: "11:00", end: "12:00" },
      { id: "scheduled:finished-order", title: "已结束", day: "2097-12-31", start: "11:00", end: "12:00" },
      { id: "proposed:waiting-order", title: "待批准", day: "2099-01-01", start: "13:00", end: "14:00" },
      { id: "optional:off-hours-order", title: "预排", day: "2099-01-01", start: "22:00", end: "23:00" },
      { id: "graph_calendar:abc", title: "上课", day: "2099-01-01", start: "14:00", end: "15:00" }
    ]
  })
}));

import { blocksToPublish } from "./calendar-publish";

describe("blocksToPublish", () => {
  // The write boundary that remains once the plan takes effect by default: only the scheduler's future blocks for real work, never a
  // preview, a pencilled-in block, a demo order or the person's own calendar.
  it("publishes only the scheduler's future blocks for real work orders, never previews, pencilled-in blocks, demo orders or the person's calendar", async () => {
    const result = await blocksToPublish({} as never, new Date("2098-01-01T00:00:00Z"));
    expect(result.blocks.map((block) => block.id).filter((id) => !id.startsWith("followup:") && !id.startsWith("deadline:"))).toEqual(["scheduled:real-order-1"]);
    expect(result.blocks.find((block) => block.id === "scheduled:real-order-1")?.reminderMinutes).toBe(10);
  });

  // The waiting item's day and two days before an approved deadline become reminder markers; a draft's deadline does not.
  it("adds follow-up and deadline markers that remind at their start", async () => {
    const result = await blocksToPublish({} as never, new Date("2098-01-01T00:00:00Z"));
    const markers = result.blocks.filter((block) => !block.id.startsWith("scheduled:"));
    expect(markers.map((block) => [block.id, block.title, block.start.slice(0, 10), block.reminderMinutes])).toEqual([
      ["followup:wait-1", "跟进：师兄的真实测量数据到了吗？", "2099-01-08", 0],
      ["deadline:m1", "2 天后到期：西湖合作论文已投出", "2099-01-29", 0]
    ]);
  });
});
