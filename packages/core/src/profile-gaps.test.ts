import { describe, expect, test } from "vitest";
import { answeredGapFacts, isCourse, mergeFacts, profileGaps, type ProfileGapInput } from "./profile-gaps";

const identities = [{ id: "research", label: "科研" }, { id: "startup", label: "创业" }];
const base: ProfileGapInput = {
  identities, projects: [{ id: "ece555", identityId: "research", name: "ECE 555" }], meetings: ["ECE 555"],
  facts: [
    { identityId: "research", projectId: "ece555", slot: "grading", value: "作业 20%、小测 30%、项目 25%、期末 25%", status: "confirmed" },
    { identityId: "startup", projectId: "", slot: "flywheel_research_informs", value: "猜的", status: "inferred" },
    { identityId: "startup", projectId: "", slot: "what", value: "猜的", status: "inferred" }
  ]
};

describe("what the profile still has to ask before milestones are designed from it", () => {
  test("a course's target grade is not asked: the model proposes it and the person changes it afterwards", () => {
    expect(profileGaps(base).map((gap) => gap.code)).toEqual(["LINE_UNCONFIRMED"]);
  });

  test("a line resting only on guesses is a gap, a line never mentioned is the interview's own job, and a declined line is closed", () => {
    expect(profileGaps(base).filter((gap) => gap.code === "LINE_UNCONFIRMED").map((gap) => gap.identityId)).toEqual(["startup"]);
    const declined = [...base.facts, { identityId: "startup", projectId: "", slot: "skipped", value: "目前没有在做的事", status: "confirmed" }];
    expect(profileGaps({ ...base, facts: declined }).some((gap) => gap.code === "LINE_UNCONFIRMED")).toBe(false);
    expect(profileGaps({ ...base, facts: base.facts.filter((fact) => fact.identityId !== "startup") }).some((gap) => gap.code === "LINE_UNCONFIRMED")).toBe(false);
  });

  test("a graded part with no day is asked once and holds nothing up", () => {
    const gaps = profileGaps({ ...base, undated: [{ project: "ece555", kind: "project_due", title: "Final Project Report" }] });
    const gap = gaps.find((item) => item.code === "DATE_UNDATED")!;
    expect(gap.blocking).toBe(false);
    expect(gap.question.text).toContain("Final Project Report");
  });
});

describe("answers to the app's own questions become facts without the model", () => {
  const gaps = profileGaps({ ...base, undated: [{ project: "ece555", kind: "project_due", title: "Final Project Report" }] });
  const text = (code: string) => gaps.find((gap) => gap.code === code)!.question.text;

  test("declining a line records that it was declined, as a verbatim span of the reply", () => {
    const reply = `【${text("LINE_UNCONFIRMED")}】选择：目前没有在做的事`;
    const [fact] = answeredGapFacts(reply, gaps);
    expect(fact).toMatchObject({ identityId: "startup", slot: "skipped", value: "目前没有在做的事" });
    expect(reply).toContain(fact!.quote);
  });

  test("「有，我来写」 alone is not a fact, but what they then write is; 「知道日期」 without the date is not an answer", () => {
    const doing = `【${text("LINE_UNCONFIRMED")}】选择：有，我来写下具体在做什么`;
    expect(answeredGapFacts(doing, gaps)).toEqual([]);
    expect(answeredGapFacts(`${doing}。补充：Crossline 内测`, gaps)).toMatchObject([{ slot: "what", value: "Crossline 内测" }]);
    expect(answeredGapFacts(`【${text("DATE_UNDATED")}】选择：知道具体日期，我来写`, gaps)).toEqual([]);
    expect(answeredGapFacts(`【${text("DATE_UNDATED")}】选择：知道具体日期，我来写。补充：12/11`, gaps)).toMatchObject([{ value: expect.stringContaining("12/11") }]);
  });
});

test("merging never lets a guess replace a confirmed fact", () => {
  const fact = (status: string, value: string) => ({ identityId: "a", projectId: "p", slot: "goal", status, value });
  expect(mergeFacts([fact("confirmed", "我说的")], [fact("inferred", "它猜的")])[0]?.value).toBe("我说的");
  expect(mergeFacts([fact("inferred", "旧猜测")], [fact("confirmed", "新确认")])[0]?.value).toBe("新确认");
});

test("a course is recognised by its grade breakdown, or by quizzes and homework dated in its files; a lone exam is not enough", () => {
  const goal = [{ projectId: "ece555", slot: "goal" }];
  expect(isCourse("ece555", [{ projectId: "ece555", slot: "grading" }])).toBe(true);
  expect(isCourse("ece555", goal)).toBe(false);
  expect(isCourse("ece555", goal, [{ project: "ece555", kind: "quiz" }])).toBe(true);
  expect(isCourse("ece555", goal, [], [{ project: "ece555", kind: "homework_due" }])).toBe(true);
  expect(isCourse("ece555", goal, [{ project: "ece555", kind: "exam" }])).toBe(false);
});

test("a course nobody said the class times of, a file only the person can file and an unconfirmed portrait are asked, and their answers act", () => {
  const input: ProfileGapInput = { ...base, projects: [...base.projects, { id: "ece548", identityId: "research", name: "ECE 548" }],
    unfiled: [{ id: "doc-1", fileName: "Lecture Plan.pdf", lean: { id: "ece548" } }], portrait: { written: true, confirmed: false } };
  const gaps = profileGaps(input);
  expect(gaps.filter((gap) => gap.code !== "LINE_UNCONFIRMED").map((gap) => gap.question.text)).toEqual([
    "「ECE 548」每周什么时候上课、在哪里？", "《Lecture Plan.pdf》属于哪个项目？", "「当前画像」里写的是否符合你？"]);
  // The project the interview leaned to is offered first.
  expect(gaps.find((gap) => gap.code === "FILE_UNFILED")!.question.options[0]).toMatchObject({ id: "ece548", detail: "访谈判断更可能是它" });
  const reply = ["【「ECE 548」每周什么时候上课、在哪里？】选择：我来写上课时间。补充：周二、四 11:00–12:15，EH 2317",
    "【《Lecture Plan.pdf》属于哪个项目？】选择：ECE 548", "【「当前画像」里写的是否符合你？】选择：符合"].join("\n");
  expect(answeredGapFacts(reply, gaps)).toEqual([
    { identityId: "research", projectId: "ece548", slot: "meeting_times", value: "周二、四 11:00–12:15，EH 2317", quote: "周二、四 11:00–12:15，EH 2317" },
    { identityId: "", projectId: "", slot: "", value: "ECE 548", quote: "ECE 548", file: { documentId: "doc-1", projectId: "ece548" } },
    { identityId: "", projectId: "", slot: "", value: "符合", quote: "符合", confirmPortrait: true }
  ]);
  expect(profileGaps({ ...input, meetings: ["ECE 555", "ece548"] }).some((gap) => gap.code === "COURSE_MEETINGS")).toBe(false);
});
