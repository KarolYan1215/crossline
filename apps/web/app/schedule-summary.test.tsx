import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ScheduleSummary } from "./schedule-summary";
import { groupChanges, groupSplits } from "./schedule-summary-model";
import type { ScheduleChange } from "../lib/crossline";

/** The text a person reads, without the tags that wrap a name for its ellipsis. */
const text = (html: string) => html.replace(/<[^>]+>/g, "");

const hw3: ScheduleChange = { blockId: "scheduled:hw3", title: "作业 3", day: "2026-10-13", from: { start: "11:00", end: "12:00" }, to: { day: "2026-10-13", start: "11:30", end: "12:30" }, cause: "11:30 Sync up" };

test("each moved block reads as one line with its cause and how far it moved, and offers 「钉回原位」", () => {
  const html = renderToStaticMarkup(<ScheduleSummary changes={[hw3,
    { blockId: "scheduled:read", title: "阅读", day: "2026-10-13", from: { start: "14:00", end: "15:00" }, to: { day: "2026-10-14", start: "09:00", end: "10:00" }, cause: "14:00 组会" }
  ]} />);
  expect(text(html)).toContain("「作业 3」因 11:30 Sync up 后移 30 分钟");
  expect(text(html)).toContain("「阅读」因 14:00 组会 改到 10/14 09:00");
  expect(html.match(/钉回原位/g)).toHaveLength(2);
  // The name is cut by CSS with the whole of it on hover, never sliced in code.
  expect(html).toContain('<span class="ss-name" title="作业 3">作业 3</span>');
});

test("a task's blocks moved the same way by one cause are one line with one 「钉回原位」 (2026-10-21: the same line twice)", () => {
  const second = { ...hw3, blockId: "scheduled:hw3:2" };
  const html = renderToStaticMarkup(<ScheduleSummary changes={[hw3, second, { ...hw3 }]} />);
  expect(html.match(/钉回原位/g)).toHaveLength(1);
  expect(text(html)).toContain("「作业 3」2 段因 11:30 Sync up 后移 30 分钟");
  expect(groupChanges([hw3, second])[0]!.changes.map((change) => change.blockId)).toEqual(["scheduled:hw3", "scheduled:hw3:2"]);
  // A different cause or shift stays its own line.
  expect(groupChanges([hw3, { ...second, cause: "12:00 午餐" }])).toHaveLength(2);
});

test("nothing moved, nothing shown", () => {
  expect(renderToStaticMarkup(<ScheduleSummary changes={[]} />)).toBe("");
});

test("a step split again after two days of not getting done is one line with nothing to press", () => {
  const html = renderToStaticMarkup(<ScheduleSummary changes={[]} splits={[{ orderId: "hw3", title: "作业 3", step: "推导第 1–2 题", days: 2 }]} />);
  expect(text(html)).toContain("「作业 3 · 推导第 1–2 题」2 天没做成，已拆成更小的步骤，第一步不超过 15 分钟");
  expect(html).not.toContain("<button");
});

test("several steps split after the same days are one line naming three of them (2026-10-21: four lines)", () => {
  const splits = ["A", "B", "C", "D"].map((title) => ({ orderId: title, title, step: "", days: 2 }));
  const html = renderToStaticMarkup(<ScheduleSummary changes={[]} splits={splits} />);
  expect(html.match(/<li/g)).toHaveLength(1);
  expect(text(html)).toContain("4 个步骤 2 天没做成，已拆成更小的步骤，第一步不超过 15 分钟：「A」、「B」、「C」 等 4 个");
  expect(groupSplits([...splits, { orderId: "x", title: "X", step: "s", days: 3 }]).map((group) => group.days)).toEqual([3, 2]);
});
