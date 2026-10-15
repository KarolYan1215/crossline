import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ReturnPanel, absenceSummary, settledBy } from "./return-panel";

const steps = [{ id: "v1s1", title: "推导第 1–2 题", done: false }, { id: "v1s2", title: "推导第 3–4 题", done: false }];
const item = { key: "hw3#v1s1", orderId: "hw3", stepId: "v1s1", title: "ECE 555 完成作业 3", step: "推导第 1–2 题", line: "research", lineLabel: "研究者",
  plannedDays: ["2026-10-11", "2026-10-12"], dueDay: "2026-10-14", p50Minutes: 60, lastStep: false, steps };
const view = { since: "2026-10-10T07:49:00.000Z", sinceDay: "2026-10-10", daysAway: 3, hoursAway: 75, items: [item],
  happened: { assistantDone: 2, proposals: 4, calendarChanges: 1, deadlinesSoon: [{ title: "ECE 548 期中 85 分", deadline: "2026-10-27" }] },
  stale: { orders: [], milestones: [] } };

test("it says how long the person was away and what happened, before anything else", () => {
  expect(absenceSummary(view)).toEqual(["离开了 3 天（上次操作 10/10）。", "期间有 1 个步骤排了时间或到了截止，下面逐项点一下，或用自己的话说。",
    "未来 7 天到期：ECE 548 期中 85 分（10/27）。", "助手期间做完 2 项准备。", "日历变化 1 次，排程已跟着调整。"]);
  expect(absenceSummary({ ...view, items: [], happened: { assistantDone: 0, proposals: 0, calendarChanges: 0, deadlinesSoon: [] } }))
    .toEqual(["离开了 3 天（上次操作 10/10）。"]);
});

test("opened under a day after the last action, it says the hours, and the day is the person's own, not UTC's", () => {
  // 20:56 in Chicago on 10/13 is already 10/14 in UTC.
  expect(absenceSummary({ ...view, since: "2026-10-14T01:56:00.000Z", sinceDay: "2026-10-13", daysAway: 0, hoursAway: 0 })[0]).toBe("上次操作在不到 1 小时前（10/13）。");
  expect(absenceSummary({ ...view, sinceDay: "2026-10-13", daysAway: 0, hoursAway: 5 })[0]).toBe("上次操作在 5 小时前（10/13）。");
});

test("each item is a task's step with its four one-tap answers and a box of its own; the page's box takes @; what was archived can be undone", () => {
  const html = renderToStaticMarkup(<ReturnPanel view={view} cleaned={{ orders: [{ id: "o", title: "旧提议" }], milestones: [], opId: "op-1" }} />);
  expect(html).toContain("ECE 555 完成作业 3 · <span class=\"return-step\">推导第 1–2 题</span>");
  for (const label of ["完成", "做了一部分", "没做，顺延", "不做了", "说说这一步做到哪了", "还有别的进展？", "@ 可指定任务、材料、里程碑或长期目标", "这次先跳过"]) expect(html).toContain(label);
  expect(html).toContain("排在 10/11、10/12 · 截止 10/14");
  expect(html).toContain("已归档超过 14 天无人处理的 1 个任务提议、0 个里程碑草稿");
  expect(html).toContain("撤销");
  // With more than one left, the rest can be rolled forward in one tap.
  const two = renderToStaticMarkup(<ReturnPanel view={{ ...view, items: [item, { ...item, key: "hw3#v1s2", stepId: "v1s2", step: "推导第 3–4 题", lastStep: true }] }} />);
  expect(two).toContain("其余 2 项都没做，顺延");
  expect(two).toContain("最后一步");
  // A step's item offers 做了一部分 even when it is the task's only open step: nothing ticked records the step as begun.
  const single = renderToStaticMarkup(<ReturnPanel view={{ ...view, items: [{ ...item, steps: [steps[0]!, { ...steps[1]!, done: true }] }] }} />);
  expect(single).toContain("做了一部分");
});

test("an answer settles what it really settles: discarding takes the task's other steps, finishing the last step finishes them, ticked steps are done", () => {
  const second = { ...item, key: "hw3#v1s2", stepId: "v1s2", step: "推导第 3–4 题", lastStep: true };
  const other = { ...item, key: "hw4#v1s1", orderId: "hw4" };
  const items = [item, second, other];
  expect(settledBy(items, item, "dropped")).toEqual({ "hw3#v1s1": "不做了", "hw3#v1s2": "不做了" });
  expect(settledBy(items, item, "rolled")).toEqual({ "hw3#v1s1": "已顺延" });
  expect(settledBy(items, item, "done")).toEqual({ "hw3#v1s1": "已完成" });
  expect(settledBy(items, second, "done")).toEqual({ "hw3#v1s2": "已完成", "hw3#v1s1": "已完成" });
  expect(settledBy(items, item, "partial", ["v1s2"])).toEqual({ "hw3#v1s1": "已记下部分完成", "hw3#v1s2": "已完成" });
});

test("today's opener sits at the top, drawn from its data", () => {
  const opener = { id: "m1", role: "nudge" as const, text: "", createdAt: "2026-10-13T14:00:00.000Z",
    card: { actions: [], items: [], clarify: { question: "10 月 13 日 周二。", options: [{ label: "打开计划", actions: [], kind: "href" as const, href: "/plan" }] }, confidence: "high" as const, nudgeKind: "opener" },
    opener: { day: "2026-10-13", label: "10 月 13 日 周二", timeZone: "America/Chicago", fixed: [], work: [{ start: "09:00", end: "10:00", title: "作业 3", line: "research" }],
      soon: [], asks: { count: 0 } } };
  const html = renderToStaticMarkup(<ReturnPanel view={view} opener={opener} />);
  expect(html.indexOf("opener-card")).toBeLessThan(html.indexOf("离开了 3 天"));
  expect(html).toContain("打开计划");
});
