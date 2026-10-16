import { expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

/** Which background facts bear on a task: a distinctive shared word, in either language the person writes in. */
test("a fact sharing a distinctive Chinese word is kept, one sharing only a common word is not", async () => {
  const { relevantBackground } = await import("./task-detail");
  const facts = [{ value: "论文初稿在写第三章", why: "" }, { value: "需要完成睡眠实验", why: "" }];
  expect(relevantBackground(facts, ["", "修改论文第二章", ""]).map((fact) => fact.value)).toEqual(["论文初稿在写第三章"]);
});

test("in English, common words (the, task, finish) do not tie a fact to a task, a distinctive term does", async () => {
  const { relevantBackground } = await import("./task-detail");
  const facts = [{ value: "The MoS2 device measurements are due in December", why: "" }, { value: "Finish the sleep study write-up", why: "" }];
  expect(relevantBackground(facts, ["", "Finish the task: plot MoS2 transfer curves", ""]).map((fact) => fact.value))
    .toEqual(["The MoS2 device measurements are due in December"]);
});
