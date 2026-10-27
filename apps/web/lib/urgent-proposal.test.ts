import { expect, test } from "vitest";
import { nearestDueProposal } from "./urgent-proposal";

test("Today names the waiting proposal nearest its due day within a week, overdue included (W-31)", () => {
  const items = [{ id: "far", title: "远", due: "2026-11-30" }, { id: "base", title: "试用门店上线准备", due: "2026-10-24" },
    { id: "none", title: "无期限" }, { id: "late", title: "已逾期", due: "2026-10-16" }];
  expect(nearestDueProposal(items, "2026-10-18")?.id).toBe("late");
  expect(nearestDueProposal(items.filter((item) => item.id !== "late"), "2026-10-18")?.id).toBe("base");
  expect(nearestDueProposal([items[0]!, items[2]!], "2026-10-18")).toBeUndefined();
});
