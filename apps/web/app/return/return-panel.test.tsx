import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ReturnPanel, absenceSummary } from "./return-panel";

const view = { since: "2026-10-10T07:49:00.000Z", sinceDay: "2026-10-10", daysAway: 3, hoursAway: 75,
  items: [{ orderId: "hw3", title: "ECE 555 完成作业 3", line: "research", lineLabel: "研究者", plannedDays: ["2026-10-11", "2026-10-12"], dueDay: "2026-10-14", p50Minutes: 60,
    steps: [{ id: "a", title: "推导第 1–2 题", done: false }, { id: "b", title: "推导第 3–4 题", done: false }] }],
  happened: { assistantDone: 2, proposals: 4, calendarChanges: 1, deadlinesSoon: [{ title: "ECE 548 期中 85 分", deadline: "2026-10-27" }] },
  stale: { orders: [], milestones: [] } };

test("it says how long the person was away and what happened, before anything else", () => {
  expect(absenceSummary(view)).toEqual(["离开了 3 天（上次操作 10/10）。", "期间有 1 项任务排了时间或到了截止，下面逐项点一下就能更新。",
    "未来 7 天到期：ECE 548 期中 85 分（10/27）。", "助手期间做完 2 项准备。", "日历变化 1 次，排程已跟着调整。"]);
  expect(absenceSummary({ ...view, items: [], happened: { assistantDone: 0, proposals: 0, calendarChanges: 0, deadlinesSoon: [] } }))
    .toEqual(["离开了 3 天（上次操作 10/10）。"]);
});

test("opened under a day after the last action, it says the hours, and the day is the person's own, not UTC's", () => {
  // 20:56 in Chicago on 10/13 is already 10/14 in UTC.
  expect(absenceSummary({ ...view, since: "2026-10-14T01:56:00.000Z", sinceDay: "2026-10-13", daysAway: 0, hoursAway: 0 })[0]).toBe("上次操作在不到 1 小时前（10/13）。");
  expect(absenceSummary({ ...view, sinceDay: "2026-10-13", daysAway: 0, hoursAway: 5 })[0]).toBe("上次操作在 5 小时前（10/13）。");
});

test("each task has its four one-tap answers, the input box is there for the rest, and what was archived can be undone", () => {
  const html = renderToStaticMarkup(<ReturnPanel view={view} cleaned={{ orders: [{ id: "o", title: "旧提议" }], milestones: [], opId: "op-1" }} />);
  for (const label of ["完成", "做了一部分", "没做，顺延", "不做了", "还有别的进展？", "这次先跳过"]) expect(html).toContain(label);
  expect(html).toContain("排在 10/11、10/12 · 截止 10/14");
  expect(html).toContain("已归档超过 14 天无人处理的 1 个任务提议、0 个里程碑草稿");
  expect(html).toContain("撤销");
  // With more than one left, the rest can be rolled forward in one tap.
  const two = renderToStaticMarkup(<ReturnPanel view={{ ...view, items: [view.items[0]!, { ...view.items[0]!, orderId: "hw4", title: "ECE 555 完成作业 4" }] }} />);
  expect(two).toContain("其余 2 项都没做，顺延");
});
