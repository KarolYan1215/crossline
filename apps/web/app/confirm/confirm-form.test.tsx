import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { ConfirmForm, confirmBody } from "./confirm-form";

const view = { messageId: "m1", orderId: "ece555-hw3", title: "完成 ECE 555 作业 3", step: "推导第 1–2 题", day: "2026-10-12", start: "09:00", end: "09:45",
  blockMinutes: 45, lastStep: false, milestoneBound: false };

test("the first row has the four answers; the screen record's estimate is offered when there is one", () => {
  const html = renderToStaticMarkup(<ConfirmForm view={{ ...view, activityMinutes: 52 }} />);
  for (const label of ["按预估完成", "超出预估", "少于预估", "未执行"]) expect(html).toContain(label);
  expect(html).toContain("屏幕记录约 52 分钟");
  expect(html).toContain("10/12 09:00–09:45，预估 45 分钟");
  expect(html).not.toContain("成果说明");
});

test("the last step of a milestone-bound task offers its evidence; an answered block shows what was recorded", () => {
  expect(renderToStaticMarkup(<ConfirmForm view={{ ...view, lastStep: true, milestoneBound: true }} />)).toContain("成果说明");
  const answered = renderToStaticMarkup(<ConfirmForm view={{ ...view, answered: { outcome: "over", minutes: 75 } }} />);
  expect(answered).toContain("已记下：用时 1 小时 15 分钟，这一步已完成");
});

test("the body carries the answer, the minutes, the screen-record choice and the evidence", () => {
  const body = confirmBody("over", { minutes: 30 });
  expect([body.get("kind"), body.get("minutes"), body.get("useActivity")]).toEqual(["over", "30", null]);
  const last = confirmBody("as_planned", { useActivity: true, note: " 第 1–4 题解答 ", files: [new File(["x"], "hw3.pdf", { type: "application/pdf" })] });
  expect([last.get("useActivity"), last.get("note"), (last.get("file") as File).name]).toEqual(["1", "第 1–4 题解答", "hw3.pdf"]);
});
