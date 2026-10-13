import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ScheduleSummary } from "./schedule-summary";

test("each moved block reads as one line with its cause and how far it moved, and offers 「钉回原位」", () => {
  const html = renderToStaticMarkup(<ScheduleSummary changes={[
    { blockId: "scheduled:hw3", title: "作业 3", day: "2026-10-13", from: { start: "11:00", end: "12:00" }, to: { day: "2026-10-13", start: "11:30", end: "12:30" }, cause: "11:30 Sync up" },
    { blockId: "scheduled:read", title: "阅读", day: "2026-10-13", from: { start: "14:00", end: "15:00" }, to: { day: "2026-10-14", start: "09:00", end: "10:00" }, cause: "14:00 组会" }
  ]} />);
  expect(html).toContain("「作业 3」因 11:30 Sync up 后移 30 分钟");
  expect(html).toContain("「阅读」因 14:00 组会 改到 10/14 09:00");
  expect(html.match(/钉回原位/g)).toHaveLength(2);
});

test("nothing moved, nothing shown", () => {
  expect(renderToStaticMarkup(<ScheduleSummary changes={[]} />)).toBe("");
});
