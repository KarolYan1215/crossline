import { expect, test } from "vitest";
import { nearestDueProposal } from "./urgent-proposal";

test("Today names the waiting proposal nearest its due day within a week, overdue included (W-31)", () => {
  const items = [{ id: "far", title: "远", due: "2026-11-30" }, { id: "base", title: "试用门店上线准备", due: "2026-10-24" },
    { id: "none", title: "无期限" }, { id: "late", title: "已逾期", due: "2026-10-16" }];
  expect(nearestDueProposal(items, "2026-10-18")?.id).toBe("late");
  expect(nearestDueProposal(items.filter((item) => item.id !== "late"), "2026-10-18")?.id).toBe("base");
  expect(nearestDueProposal([items[0]!, items[2]!], "2026-10-18")).toBeUndefined();
});

test("two proposals due the same day are both counted, not one named and the other hidden (2026-11-11, W-257)", () => {
  // The owner's Today named 「发布小红书首轮科研内容」 due 11/12 and said nothing of 「完成 ECE 548 作业 4」, also due 11/12 and also waiting.
  const items = [{ id: "xhs", title: "发布小红书首轮科研内容", due: "2026-11-12" }, { id: "hw4", title: "完成 ECE 548 作业 4", due: "2026-11-12" },
    { id: "later", title: "设计反馈模板", due: "2026-11-16" }, { id: "far", title: "远", due: "2026-12-30" }];
  expect(nearestDueProposal(items, "2026-11-11")).toMatchObject({ id: "xhs", more: 2 });
  expect(nearestDueProposal([items[3]!], "2026-11-11")).toBeUndefined();
  expect(nearestDueProposal([items[2]!], "2026-11-11")).toMatchObject({ id: "later", more: 0 });
});
