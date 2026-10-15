import { expect, test } from "vitest";
import { readPartialTurn } from "./onboarding-progress";

test("a half-written interview answer is counted by section, and its reply read as far as it goes", () => {
  const full = JSON.stringify({
    reply: "课表读出来了：\"ECE 548\" 周二周四上午有课。",
    questions: [{ id: "q1", text: "哪些时间能干活？", kind: "single", options: [] }, { id: "q2", text: "截止？", kind: "free", options: [] }],
    slotUpdates: [{ identityId: "r", projectId: "", slot: "what", value: "博三" }, { identityId: "r", projectId: "p", slot: "deadline", value: "10/31" }],
    projectsDetected: [], flywheelCandidates: [], coverage: [],
    fileDates: { dates: [{ id: "d1", date: "2026-10-23", kind: "exam" }], recurring: [{ id: "r1", weekdays: [2, 4] }], undated: [] },
    nextAction: "ask"
  });
  expect(readPartialTurn(full)).toEqual({ reply: "课表读出来了：\"ECE 548\" 周二周四上午有课。", questions: 2, facts: 2, dates: 2 });
  // Cut inside the reply, right after an escape began: the half escape is dropped, not shown.
  const cut = full.slice(0, full.indexOf("ECE") - 1);
  expect(readPartialTurn(cut)).toEqual({ reply: "课表读出来了：", questions: 0, facts: 0, dates: 0 });
  // Cut in the middle of the facts: the questions are all in, the facts so far are counted, no dates yet.
  const mid = full.slice(0, full.indexOf("deadline"));
  expect(readPartialTurn(mid)).toMatchObject({ questions: 2, facts: 2, dates: 0 });
  expect(readPartialTurn("")).toEqual({ reply: "", questions: 0, facts: 0, dates: 0 });
});
