import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import type { Hypothesis } from "./interview-contract";
import { boardColumns, HypothesisBoard, LifelineView, loopPoints, LoopView, ScaleReadings } from "./story-views";

const hypothesis = (id: string, status: Hypothesis["status"], dimension = "D4"): Hypothesis =>
  ({ id, status, dimension, statement: `假设 ${id}` }) as Hypothesis;

test("the board sorts the hypotheses by where the evidence left them, open and undecided together", () => {
  const columns = boardColumns([hypothesis("a", "supported"), hypothesis("b", "open"), hypothesis("c", "undecided"), hypothesis("d", "refuted")]);
  expect(columns.supported.map((item) => item.id)).toEqual(["a"]);
  expect(columns.pending.map((item) => item.id)).toEqual(["b", "c"]);
  expect(columns.refuted.map((item) => item.id)).toEqual(["d"]);
  expect(renderToStaticMarkup(<HypothesisBoard hypotheses={[]} onOpen={() => {}} />)).toBe("");
  const html = renderToStaticMarkup(<HypothesisBoard hypotheses={[hypothesis("a", "supported")]} onOpen={() => {}} />);
  expect(html).toContain("假设 a");
  expect(html).toContain("已推翻");
});

test("the lifeline draws only what the record holds, and says what will come when it holds nothing", () => {
  expect(renderToStaticMarkup(<LifelineView turns={[" "]} />)).toContain("经历部分谈到的转折会画在这里。");
  const html = renderToStaticMarkup(<LifelineView theme="从工具到人" turns={["转去读研", "退出创业"]} next="开一间工作室" />);
  expect(html.indexOf("转去读研")).toBeLessThan(html.indexOf("退出创业"));
  expect(html).toContain("下一章");
  expect(html).toContain("开一间工作室");
});

test("the loop draws the unrefuted D9 steps round a circle, the first at the top, and needs at least two", () => {
  expect(loopPoints(4)).toEqual([{ x: 100, y: 30 }, { x: 170, y: 100 }, { x: 100, y: 170 }, { x: 30, y: 100 }]);
  expect(renderToStaticMarkup(<LoopView hypotheses={[hypothesis("a", "open", "D9"), hypothesis("b", "refuted", "D9")]} />))
    .toContain("收尾时和你核对的维持循环会画在这里。");
  const html = renderToStaticMarkup(<LoopView hypotheses={[hypothesis("a", "open", "D9"), hypothesis("b", "supported", "D9"), hypothesis("c", "open", "D4")]} />);
  expect(html).toContain("<svg");
  expect(html).toContain("假设 a");
  expect(html).not.toContain("假设 c");
  expect(html).toContain("最后一步又回到第一步。");
});

test("the cards' readings come back as levels in words, never a number", () => {
  expect(renderToStaticMarkup(<ScaleReadings readings={[]} />)).toBe("");
  const html = renderToStaticMarkup(<ScaleReadings readings={[{ label: "外向", level: "偏高" }]} />);
  expect(html).toContain("外向");
  expect(html).toContain("偏高");
  expect(html).not.toMatch(/\d+\/100/u);
});
