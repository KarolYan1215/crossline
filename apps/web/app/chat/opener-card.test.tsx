import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
vi.mock("./opener-card.css", () => ({}));
import { OpenerCard } from "./opener-card";
import { blockSpan, openerAxis, readOpener, workMinutes, type OpenerView } from "../../lib/opener";

const opener: OpenerView = {
  day: "2026-10-15", label: "10 月 15 日 周四", timeZone: "America/Chicago",
  fixed: [{ start: "17:00", end: "20:00", title: "Build Nights (Transcend x TEL)", line: "startup" }],
  work: [{ start: "09:00", end: "09:25", title: "ECE 555 确认课程项目评分标准", line: "research" },
    { start: "09:25", end: "10:00", title: "确认核心流程完成标准", step: "汇集现有流程材料", line: "startup" },
    { start: "20:00", end: "21:00", title: "汇集当前论文材料", step: "汇总论文基线包" }],
  soon: [{ title: "ECE 555 完成作业 3", due: "2026-10-16", line: "research" }],
  asks: { count: 14, top: { title: "访谈未完成", urgency: "now", line: "research" } }
};

test("the axis covers the working day and widens to whole hours around anything outside it", () => {
  expect(openerAxis(opener)).toEqual({ from: 8 * 60, to: 21 * 60 });
  expect(openerAxis({ fixed: [], work: [] })).toEqual({ from: 8 * 60, to: 20 * 60 });
  expect(openerAxis({ fixed: [{ start: "06:30", end: "07:00", title: "x" }], work: [{ start: "22:10", end: "23:40", title: "y" }] })).toEqual({ from: 6 * 60, to: 24 * 60 });
  const span = blockSpan({ start: "17:00", end: "20:00", title: "x" }, { from: 8 * 60, to: 20 * 60 });
  expect(span.left).toBeCloseTo(75);
  expect(span.width).toBeCloseTo(25);
  expect(workMinutes(opener)).toBe(120);
});

test("the card draws the day: a badge for what waits, one block per arrangement in its line's colour, the most urgent set apart", () => {
  const html = renderToStaticMarkup(<OpenerCard opener={opener} />);
  expect(html).toContain("10 月 15 日 周四");
  expect(html).toContain("待决 <span>14</span>");
  expect(html.match(/class="opener-block"/g)).toHaveLength(4);
  expect(html).toContain("data-line=\"startup\"");
  expect(html).toContain("data-line=\"none\"");
  expect(html).toContain("3 段 · 共 2 小时");
  expect(html).toContain("17:00–20:00 Build Nights (Transcend x TEL)");
  expect(html).toContain("最紧急 · 两天内");
  expect(html).toContain("访谈未完成");
  expect(html).toContain("ECE 555 完成作业 3<small>10/16</small>");
});

test("an empty day says so in words, and a stored payload of another shape is not taken for one", () => {
  const html = renderToStaticMarkup(<OpenerCard opener={{ ...opener, fixed: [], work: [], soon: [], asks: { count: 0 } }} />);
  expect(html).toContain("今天没有排给工作的时段");
  expect(html).toContain("今天没有固定安排");
  expect(html).toContain("没有待决");
  expect(readOpener(opener)).toBe(opener);
  expect(readOpener(undefined)).toBeUndefined();
  expect(readOpener({ day: "2026-10-15" })).toBeUndefined();
});
