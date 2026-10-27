import { expect, test } from "vitest";
import type { Ask } from "@crossline/core";
import { answerBody, answerProblem, askOutcome, askSources, byQuadrant, entryHistogram, itemsShown, quotedName, uniqueAsks } from "./model";

test("a folded card shows five rows and counts the rest until expanded", () => {
  const rows = Array.from({ length: 25 }, (_, index) => index);
  expect(itemsShown(rows, false)).toEqual({ shown: [0, 1, 2, 3, 4], more: 20 });
  expect(itemsShown(rows, true)).toEqual({ shown: rows, more: 0 });
  expect(itemsShown([1, 2, 3], false)).toEqual({ shown: [1, 2, 3], more: 0 });
});

const ask = (over: Partial<Ask>): Ask => ({ id: "a", kind: "gate_insufficient", entityId: "wo-1", title: "「完成 ECE 555 作业 2」未通过验收", why: "缺证据。",
  urgency: "later", raisedAt: "", fingerprint: "f", options: [{ id: "redo", label: "重新排上，补做缺的", recommended: true }], ...over });

test("every card says what an answer does and what silence does; a recommended option's own detail wins", () => {
  expect(askOutcome(ask({}))).toEqual({ answered: "重新排上补做，补交后重新判定。", unanswered: "任务保持未通过，不计入里程碑进度。" });
  const detailed = askOutcome(ask({ kind: "missed_block", options: [{ id: "roll", label: "顺延就好", detail: "按重新排的时间做", recommended: true }] }));
  expect(detailed.answered).toBe("推荐「顺延就好」：按重新排的时间做");
  expect(detailed.unanswered).toContain("顺延");
});

test("an ask links what it is about, named from its title, and does not repeat a link an option already gives", () => {
  expect(quotedName("《syllabus.pdf》属于哪个项目？")).toBe("《syllabus.pdf》");
  expect(askSources(ask({}))).toEqual([{ label: "任务「完成 ECE 555 作业 2」", href: "/workbench/wo-1" }]);
  expect(askSources(ask({ options: [{ id: "look", label: "去看", href: "/workbench/wo-1" }] }))).toEqual([]);
  expect(askSources(ask({ kind: "milestone_risk", entityId: "m 1", title: "「期中」可能赶不上 11/24" }))[0]).toEqual({ label: "里程碑「期中」", href: "/milestones?open=m%201" });
  expect(askSources(ask({ kind: "source_project", entityId: "doc-1", title: "《a.pdf》属于哪个项目？" }))[0]!.href).toBe("/api/source-documents/doc-1/file");
  expect(askSources(ask({ kind: "event_propose" }))).toEqual([]);
});

test("asks fall into the four quadrants by the contract's own rule, and a repeated id is shown once", () => {
  const groups = byQuadrant([ask({ id: "1", urgency: "now", important: true }), ask({ id: "2", importance: 80 }), ask({ id: "3", urgency: "now" }), ask({ id: "4" })]);
  expect(Object.fromEntries(Object.entries(groups).map(([key, list]) => [key, list.map((item) => item.id)])))
    .toEqual({ urgent_important: ["1"], important: ["2"], urgent: ["3"], neither: ["4"] });
  expect(uniqueAsks([ask({ id: "x" }), ask({ id: "x" }), ask({ id: "y" })]).map((item) => item.id)).toEqual(["x", "y"]);
});

test("an answer goes out in the shape the route takes: one option also as optionId, several only as optionIds, a note only when written", () => {
  expect(answerBody("a", ["o1"], {}, "  ")).toEqual({ askId: "a", optionIds: ["o1"], optionId: "o1", values: {} });
  expect(answerBody("a", ["o1", "o2"], { date: "2026-10-20" }, "两门都要")).toEqual({ askId: "a", optionIds: ["o1", "o2"], values: { date: "2026-10-20" }, note: "两门都要" });
  expect(answerBody("a", [], {}, "自己写的")).toEqual({ askId: "a", optionIds: [], values: {}, note: "自己写的" });
  expect(answerProblem("ASK_SINGLE_CHOICE")).toBe("这一题只能选一项");
  expect(answerProblem(undefined)).toBe("未保存，请重试");
});

test("the days decisions that can wait come into the week are counted per day, the far ones on the last bar", () => {
  const bars = entryHistogram(["2026-10-16", "2026-10-16", "2026-10-20", "2027-01-01", "2026-10-01"], "2026-10-15", 28);
  expect(bars).toHaveLength(28);
  expect(bars[0]).toEqual({ day: "2026-10-15", count: 1 });
  expect(bars[1]).toEqual({ day: "2026-10-16", count: 2 });
  expect(bars[5]!.count).toBe(1);
  expect(bars[27]!.count).toBe(1);
});

test("in English the outcome, sources and refusals are English, and names quoted the English way are found", () => {
  expect(quotedName("Is “Midterm” at risk before Nov 24?")).toBe("“Midterm”");
  expect(quotedName('Which project does "syllabus.pdf" belong to?')).toBe('"syllabus.pdf"');
  expect(askSources({ kind: "milestone_risk", entityId: "m1", title: "“Midterm” may be late", options: [] }, "en")[0])
    .toEqual({ label: "Milestone “Midterm”", href: "/milestones?open=m1" });
  expect(askSources({ kind: "capture_blocked", entityId: "c", title: "x", options: [] }, "en")[0]!.label).toBe("Capture");
  expect(askOutcome({ kind: "gate_failed", options: [] }, "en")).toEqual({ answered: "The acceptance check runs again.", unanswered: "The submitted evidence remains unjudged." });
  expect(askOutcome({ kind: "missed_block", options: [{ id: "r", label: "Roll over", detail: "Done at the new time", recommended: true }] }, "en").answered)
    .toBe("Recommended \"Roll over\": Done at the new time");
  expect(answerProblem("ASK_SINGLE_CHOICE", "en")).toBe("Pick only one for this question");
});
