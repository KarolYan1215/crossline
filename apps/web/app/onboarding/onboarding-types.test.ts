import { expect, test } from "vitest";
import { composeAnswers, type Question } from "./onboarding-types";

const question: Question = { id: "q1", text: "你现在卡在哪？", kind: "multi", allowOther: true, identityId: "research", projectId: "",
  options: [{ id: "a", label: "等待真实测量数据", detail: "" }, { id: "b", label: "论文写作进度慢", detail: "" }] };

test("picked options are written out in full so the interview can quote them", () => {
  const text = composeAnswers([question], { q1: { picked: ["a", "b"], other: "" } }, "");
  expect(text).toBe("【你现在卡在哪？】选择：等待真实测量数据；论文写作进度慢");
});

test("a written addition and free text are kept, and unanswered questions are left out", () => {
  const second: Question = { ...question, id: "q2", text: "每周投入？" };
  const text = composeAnswers([question, second], { q1: { picked: ["a"], other: "还缺校准" } }, "另外还有一件事");
  expect(text).toBe("【你现在卡在哪？】选择：等待真实测量数据。补充：还缺校准\n另外还有一件事");
});

test("nothing answered composes to nothing", () => {
  expect(composeAnswers([question], {}, "  ")).toBe("");
});
