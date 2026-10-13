import { expect, test } from "vitest";
import { interviewChecklist, interviewOwnedOpen, portraitFingerprint, readyToStart, type ChecklistInput } from "./index";

const full: ChecklistInput = {
  lines: [{ id: "research", label: "研究者", hard: true, goals: ["成为外推知识边界的研究者"] }],
  descriptions: { research: { description: "以博士训练为底座", candidates: 3 } },
  profile: { portrait: "p", coreConflict: "c", problem: "q", workView: "w", lifeView: "l", trueNorth: "t", says: "s", does: "d", anchor: "a",
    energyMap: [{ activity: "x", skill: "high", love: "high", charge: "charge" }, { activity: "y", skill: "low", love: "low", charge: "drain" },
      { activity: "z", skill: "high", love: "low", charge: "drain" }] },
  facts: [
    { identityId: "person", projectId: "", slot: "line_constraint", status: "confirmed", sourceRef: "reply-3" },
    { identityId: "person", projectId: "", slot: "work_view", status: "confirmed", sourceRef: "src-5" },
    { identityId: "person", projectId: "", slot: "flow", status: "confirmed", sourceRef: "src-5" },
    { identityId: "research", projectId: "ece555", slot: "grading", status: "confirmed", sourceRef: "src-1" },
    { identityId: "research", projectId: "ece555", slot: "goal", status: "confirmed", sourceRef: "reply-2" },
    { identityId: "research", projectId: "ece555", slot: "evidence", status: "confirmed", sourceRef: "reply-2" }],
  projects: [{ id: "ece555", identityId: "research", name: "ECE 555" }, { id: "research-default", identityId: "research", name: "研究者" }],
  dates: [{ project: "ECE 555", kind: "class", recurring: true, pending: false, sourceRef: "src-2" }, { project: "ECE 555", kind: "exam", recurring: false, pending: false, sourceRef: "src-1" }],
  availability: true, unfiledFiles: 0, portraitConfirmed: true
};

test("a complete record ticks every item, the portrait included", () => {
  const items = interviewChecklist(full);
  expect(items.filter((item) => !item.done)).toEqual([]);
  expect(items.map((item) => item.id)).toEqual(["portrait_fields", "portrait_grounded", "portrait_confirmed", "line_desc:research", "line_goal:research",
    "hard_schedule:research", "availability", "line_project:research", "project:ece555", "files_filed"]);
});

test("a portrait written only from inferences is not finished, and what is missing is named", () => {
  const items = interviewChecklist({ ...full, facts: full.facts.filter((fact) => fact.identityId !== "person"), profile: { ...full.profile, trueNorth: "", energyMap: [] } });
  expect(items.find((item) => item.id === "portrait_grounded")).toMatchObject({ done: false, detail: "尚无本人依据：现状与真问题、工作观与人生观、能量与心流" });
  expect(items.find((item) => item.id === "portrait_fields")?.detail).toContain("正北");
  expect(interviewOwnedOpen(items).map((item) => item.id)).toEqual(["portrait_fields", "portrait_grounded"]);
});

test("what only the person can settle is theirs, and does not count as the interview's", () => {
  const items = interviewChecklist({ ...full, lines: [{ ...full.lines[0]!, goals: [] }], portraitConfirmed: false, unfiledFiles: 2,
    dates: [...full.dates, { project: "ECE 548", kind: "exam", recurring: false, pending: true, sourceRef: "src-4" }] });
  const open = items.filter((item) => !item.done);
  expect(open.map((item) => [item.id, item.owner])).toEqual([["portrait_confirmed", "person"], ["line_goal:research", "person"], ["dates_confirmed", "person"], ["files_filed", "person"]]);
  expect(interviewOwnedOpen(items)).toEqual([]);
});

test("a course needs its grading and its class times, a hard line its fixed schedule; a confirmation lasts only while the portrait is the same", () => {
  const items = interviewChecklist({ ...full, facts: full.facts.filter((fact) => fact.slot !== "grading"), dates: full.dates.filter((entry) => !entry.recurring) });
  expect(items.find((item) => item.id === "project:ece555")?.detail).toBe("缺：评分占比、上课时间");
  expect(items.find((item) => item.id === "hard_schedule:research")?.done).toBe(false);
  expect(portraitFingerprint({ portrait: "a b", coreConflict: "c" })).toBe(portraitFingerprint({ portrait: "ab", coreConflict: "c" }));
  expect(portraitFingerprint({ portrait: "a" })).not.toBe(portraitFingerprint({ portrait: "b" }));
});

test("what the person could not say is assumed (「假设：」) and settles the item, saying so; a bare guess does not", () => {
  const without = { ...full, facts: full.facts.filter((fact) => fact.identityId !== "person" || !/energy|flow/.test(fact.slot)) };
  expect(interviewChecklist(without).find((item) => item.id === "portrait_grounded")?.done).toBe(false);
  const guessed = { ...without, facts: [...without.facts, { identityId: "person", projectId: "", slot: "energy_sources", status: "inferred", sourceRef: "", value: "深夜写代码" }] };
  expect(interviewChecklist(guessed).find((item) => item.id === "portrait_grounded")?.done).toBe(false);
  const assumed = { ...without, facts: [...without.facts, { identityId: "person", projectId: "", slot: "energy_sources", status: "inferred", sourceRef: "", value: "假设：深夜写代码时充电" }] };
  expect(interviewChecklist(assumed).find((item) => item.id === "portrait_grounded")).toMatchObject({ done: true, detail: "以假设代替：能量与心流" });
});

test("可开始标准：五条打标，全满足才算；画像不要求", () => {
  const items = interviewChecklist({ ...full, portraitConfirmed: false, profile: {} });
  expect(items.filter((item) => item.start).map((item) => item.id))
    .toEqual(["line_desc:research", "line_goal:research", "hard_schedule:research", "availability", "line_project:research"]);
  expect(readyToStart(items)).toBe(true);
  expect(items.find((item) => item.id === "portrait_fields")?.done).toBe(false);
});

test("可开始标准不认「假设：」：硬约束日程与截止只认本人确认或文件", () => {
  const assumed = { ...full, dates: full.dates.filter((entry) => !entry.recurring),
    facts: [...full.facts, { identityId: "research", projectId: "", slot: "fixed_schedule", status: "inferred", sourceRef: "", value: "假设：周二四上课" }] };
  expect(interviewChecklist(assumed).find((item) => item.id === "hard_schedule:research")?.done).toBe(false);
  expect(readyToStart(interviewChecklist(assumed))).toBe(false);
});

test("每条主线至少一个当前项目且知道截止；「没有截止」也算", () => {
  const undated = { ...full, dates: full.dates.filter((entry) => entry.recurring) };
  expect(interviewChecklist(undated).find((item) => item.id === "line_project:research")).toMatchObject({ done: false, owner: "interview" });
  const none = { ...undated, facts: [...undated.facts, { identityId: "research", projectId: "ece555", slot: "no_deadline", status: "confirmed", sourceRef: "reply-4", value: "没有截止" }] };
  expect(interviewChecklist(none).find((item) => item.id === "line_project:research")?.done).toBe(true);
  // 只有 `-default` 项目不算「当前项目」。
  const onlyDefault = { ...full, projects: full.projects.filter((project) => project.id.endsWith("-default")) };
  expect(interviewChecklist(onlyDefault).find((item) => item.id === "line_project:research")?.detail).toBe("尚无当前项目");
});
