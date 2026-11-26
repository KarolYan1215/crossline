import { expect, test } from "vitest";
import { conformanceCases, INTERVIEW_TOOLS_CASE_ID } from "@crossline/core";
import { caseTools } from "./conformance-tools";

const card = { id: "q1", text: "哪几个晚上通常空着？", kind: "single", allowOther: true, date: false, identityId: "", projectId: "", repeats: 0,
  followUp: false, about: "", gist: "", options: [{ id: "a", label: "周二、周四", detail: "" }, { id: "b", label: "几乎没有", detail: "" }] };

test("the interview card-tools case answers a card that breaks the schema with its problems and counts only a valid call", async () => {
  const item = conformanceCases().find((entry) => entry.id === INTERVIEW_TOOLS_CASE_ID)!;
  const { tools, check } = caseTools(item);
  await expect(async () => tools!.call("ask_question", { id: "q1", text: "空着吗？" })).rejects.toThrow(/参数不合格/);
  expect(() => check({ code: item.tool!.reply })).toThrow("CONFORMANCE_TOOL_NOT_CALLED");
  expect(await tools!.call("ask_question", card)).toBe(item.tool!.reply);
  expect(() => check({ code: item.tool!.reply })).not.toThrow();
  expect(() => check({ code: "other" })).toThrow("CONFORMANCE_TOOL_IGNORED");
});

test("the generic tools case takes any arguments, as before", async () => {
  const item = conformanceCases().find((entry) => entry.id === "ADVERSARIAL_TOOLS")!;
  const { tools, check } = caseTools(item);
  expect(await tools!.call("lookup_code", {})).toBe(item.tool!.reply);
  expect(() => check({ code: item.tool!.reply })).not.toThrow();
});
