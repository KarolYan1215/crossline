import { expect, test } from "vitest";
import { gapWorthAsking, validateDeliverableCheck } from "./deliverables";

const docs = [{ id: "d1", text: "Q1. 推导 KCL。\n\nQ2.   求解电路。" }, { id: "d2", text: "牛奶 鸡蛋" }];
const item = (extra: Record<string, unknown>) => ({ doc: "d1", task: "t1", verdict: "deliverable", criterion: "pass", quote: "Q2. 求解电路。", gap: "", external: false, why: "w", ...extra });
const unrelated = { doc: "d2", task: "x", verdict: "unrelated", criterion: "cannot_read", quote: "", gap: "", external: false, why: "w" };
const detail = (run: () => unknown) => { try { run(); return ""; } catch (error) { return (error as { detail?: string }).detail ?? ""; } };

test("a verbatim quote passes with whitespace squashed; an unrelated file's task is cleared", () => {
  const out = validateDeliverableCheck({ items: [item({}), unrelated] }, docs, ["t1"]);
  expect(out.items[1]!.task).toBe("");
  expect(out.items[0]!.quote).toBe("Q2. 求解电路。");
});

test("a paraphrased quote, an unknown task, a gap without what is missing and an unanswered file are each sent back", () => {
  expect(detail(() => validateDeliverableCheck({ items: [item({ quote: "求解了电路" }), unrelated] }, docs, ["t1"]))).toContain("逐字");
  expect(detail(() => validateDeliverableCheck({ items: [item({ task: "t9" }), unrelated] }, docs, ["t1"]))).toContain("不在候选任务里");
  expect(detail(() => validateDeliverableCheck({ items: [item({ criterion: "gap" }), unrelated] }, docs, ["t1"]))).toContain("gap 要写缺什么");
  expect(detail(() => validateDeliverableCheck({ items: [item({})] }, docs, ["t1"]))).toContain("d2");
});

test("a gap is worth asking only when the task bears on a milestone or the shortfall goes outside", () => {
  expect(gapWorthAsking({ criterion: "gap", external: false }, "")).toBe(false);
  expect(gapWorthAsking({ criterion: "gap", external: false }, "m1")).toBe(true);
  expect(gapWorthAsking({ criterion: "gap", external: true }, "")).toBe(true);
  expect(gapWorthAsking({ criterion: "pass", external: true }, "m1")).toBe(false);
});
