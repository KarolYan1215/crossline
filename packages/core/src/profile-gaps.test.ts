import { describe, expect, test } from "vitest";
import { answeredGapFacts, isCourse, profileGaps, undatedKey, type ProfileGapInput } from "./profile-gaps";

const identities = [{ id: "research", label: "科研" }, { id: "startup", label: "创业" }];
/** A course on record: its grading breakdown, as the extraction writes it from a syllabus (IR-028: no longer the name's shape). */
const grading = (projectId: string) => ({ identityId: "research", projectId, slot: "grading", value: "作业 30%、期末 70%", status: "confirmed" });
const base: ProfileGapInput = {
  identities, projects: [{ id: "ece555", identityId: "research", name: "ECE 555" }], meetings: ["ECE 555"], dated: ["ECE 555", "ece548"],
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

  test("a file's relative day (「下周五」) is put to the person as a question, with the file's words, even with no project (W-228)", () => {
    const gaps = profileGaps({ ...base, undated: [{ project: "", kind: "class", title: "补课", note: "relative:下周五补课" }] });
    const gap = gaps.find((item) => item.code === "DATE_UNDATED" && item.question.text.includes("补课"))!;
    expect(gap.blocking).toBe(false);
    expect(gap.question.text).toBe("文件里写的「下周五补课」（补课）是哪一天？");
    expect(gap.question.options.map((option) => option.id)).toEqual(["known", "unknown"]);
    // Already answered: not asked again.
    const answered = profileGaps({ ...base, facts: [...base.facts, { identityId: "", projectId: "", slot: "undated_buke", value: "补课 11-14", status: "confirmed" }],
      undated: [{ project: "", kind: "class", title: "补课", note: "relative:下周五补课" }] });
    expect(answered.some((item) => item.question.text.includes("下周五补课"))).toBe(false);
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
    // What they type about the line is the extraction's to read: 「说不好」 was once written as the line's description (2026-11-14 audit).
    expect(answeredGapFacts(`${doing}。补充：Crossline 内测`, gaps)).toEqual([]);
    expect(answeredGapFacts(`【${text("DATE_UNDATED")}】选择：知道具体日期，我来写`, gaps)).toEqual([]);
    expect(answeredGapFacts(`【${text("DATE_UNDATED")}】选择：知道具体日期，我来写。补充：12/11`, gaps)).toMatchObject([{ value: expect.stringContaining("12/11") }]);
  });
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
  const input: ProfileGapInput = { ...base, projects: [...base.projects, { id: "ece548", identityId: "research", name: "ECE 548" }], facts: [...base.facts, grading("ece548")],
    unfiled: [{ id: "doc-1", fileName: "Lecture Plan.pdf", lean: { id: "ece548" } }], portrait: { written: true, confirmed: false } };
  const gaps = profileGaps(input);
  expect(gaps.filter((gap) => gap.code !== "LINE_UNCONFIRMED").map((gap) => gap.question.text)).toEqual([
    "「ECE 548」每周什么时候上课？", "《Lecture Plan.pdf》属于哪个项目？", "「当前画像」写的是否符合本人？",
    "画像报告会为本人生成一个卡通形象。希望它是什么样子（性别、发型、常穿的衣服或颜色）？这些描述只用于生成形象。"]);
  // The project the interview leaned to is offered first.
  expect(gaps.find((gap) => gap.code === "FILE_UNFILED")!.question.options[0]).toMatchObject({ id: "ece548", detail: "访谈判断更可能是它" });
  const reply = ["【「ECE 548」每周什么时候上课、在哪里？】选择：我来写上课时间。补充：周二、四 11:00–12:15，EH 2317",
    "【《Lecture Plan.pdf》属于哪个项目？】选择：ECE 548", "【「当前画像」写的是否符合本人？】选择：符合"].join("\n");
  expect(answeredGapFacts(reply, gaps)).toEqual([
    { identityId: "research", projectId: "ece548", slot: "meeting_times", value: "周二、四 11:00–12:15，EH 2317", quote: "周二、四 11:00–12:15，EH 2317" },
    { identityId: "", projectId: "", slot: "", value: "ECE 548", quote: "ECE 548", file: { documentId: "doc-1", projectId: "ece548" } },
    { identityId: "", projectId: "", slot: "", value: "符合", quote: "符合", confirmPortrait: true }
  ]);
  // A round stored before the rewording is answered in its old words, and still confirms the portrait.
  expect(answeredGapFacts("【「当前画像」里写的是否符合你？】选择：符合", gaps)).toEqual([{ identityId: "", projectId: "", slot: "", value: "符合", quote: "符合", confirmPortrait: true }]);
  expect(profileGaps({ ...input, meetings: ["ECE 555", "ece548"] }).some((gap) => gap.code === "COURSE_MEETINGS")).toBe(false);
});

test("外貌在画像写成后问一次，说明只用于生成形象；答了或已知就不再问，不描述也记下", () => {
  const input: ProfileGapInput = { ...base, portrait: { written: true, confirmed: true } };
  const gap = profileGaps(input).find((item) => item.code === "APPEARANCE")!;
  expect(gap).toMatchObject({ identityId: "person", blocking: false });
  expect(gap.question.text).toContain("只用于生成形象");
  expect(answeredGapFacts(`【${gap.question.text}】选择：我来描述。补充：男，狼尾长发，常穿全黑`, [gap]))
    .toEqual([{ identityId: "person", projectId: "", slot: "appearance", value: "男，狼尾长发，常穿全黑", quote: "男，狼尾长发，常穿全黑" }]);
  expect(answeredGapFacts(`【${gap.question.text}】选择：不描述，用中性形象`, [gap])).toEqual([expect.objectContaining({ slot: "appearance_skipped" })]);
  // Not before the portrait exists, and not once the person has said how they look.
  expect(profileGaps({ ...input, portrait: { written: false, confirmed: false } }).some((item) => item.code === "APPEARANCE")).toBe(false);
  const said = [...base.facts, { identityId: "person", projectId: "", slot: "hairstyle", value: "狼尾长发", status: "confirmed" }];
  expect(profileGaps({ ...input, facts: said }).some((item) => item.code === "APPEARANCE")).toBe(false);
});

test("一个非默认项目没有截止时，问「有截止日期吗」，答「没有截止」写成 no_deadline", () => {
  const gaps = profileGaps({ identities: [{ id: "media", label: "创作者" }], projects: [{ id: "xhs", identityId: "media", name: "小红书自媒体" }],
    facts: [{ identityId: "media", projectId: "xhs", slot: "what", value: "账号", status: "confirmed" }] });
  const gap = gaps.find((item) => item.code === "PROJECT_DEADLINE")!;
  expect(gap).toMatchObject({ projectId: "xhs", blocking: true });
  expect(answeredGapFacts(`【${gap.question.text}】选择：没有截止`, gaps)).toEqual([expect.objectContaining({ slot: "no_deadline", value: "没有截止" })]);
  expect(answeredGapFacts(`【${gap.question.text}】选择：我来写日期。补充：2026-12-15`, gaps)).toEqual([expect.objectContaining({ slot: "deadline", value: "2026-12-15" })]);
  expect(answeredGapFacts(`【${gap.question.text}】选择：我来写日期。补充：12 月中`, gaps)).toEqual([expect.objectContaining({ slot: "deadline", value: "12 月中" })]);
  // Words that say no day are not a deadline: 「还不知道」 closed the start item as a confirmed deadline (2026-11-14 audit). They stay in
  // the reply for the extraction to read.
  expect(answeredGapFacts(`【${gap.question.text}】选择：我来写日期。补充：还不知道`, gaps)).toEqual([]);
  expect(answeredGapFacts(`【${gap.question.text}】选择：我来写日期。补充：看导师安排`, gaps)).toEqual([]);
  // A picked 「没有截止」 stands with words under it (replay 16 asked the same project three rounds running); a day typed under it wins.
  expect(answeredGapFacts(`【${gap.question.text}】选择：没有截止。补充：各家招聘自己定时间，我这边没设过日期。`, gaps))
    .toEqual([expect.objectContaining({ slot: "no_deadline", value: "没有截止" })]);
  expect(answeredGapFacts(`【${gap.question.text}】选择：没有截止。补充：其实 12 月中要交`, gaps)).toEqual([expect.objectContaining({ slot: "deadline" })]);
});

// Found walking the app as an invitee (2026-10-15): the interview asked when 「RBT 610 期末项目」 meets, and for 「大致日期」 of a weekly
// homework deadline the model had filed as undated. Since 2026-11-25 (IR-028) a course is one with a grading breakdown on record; a name
// shaped like a course code (「RBT 611」) or like a course's part (「期末项目」) decides nothing, the interview asks.
test("only a course on record is asked when it meets; a part of it and a weekly deadline are not asked as meetings or undated dates", () => {
  const input: ProfileGapInput = { ...base, meetings: ["rbt610"], dated: ["rbt610", "rbt610-final", "dsc520"],
    facts: [...base.facts, grading("rbt610"), grading("dsc520")],
    projects: [{ id: "rbt610", identityId: "research", name: "RBT 610 Robot Perception" }, { id: "rbt610-final", identityId: "research", name: "RBT 610 期末项目" },
      { id: "dsc520", identityId: "research", name: "DSC 520" }, { id: "rbt611", identityId: "research", name: "RBT 611" }],
    undated: [{ project: "dsc520", title: "DSC 520 每周作业截止", kind: "homework" }] } as ProfileGapInput;
  const gaps = profileGaps(input);
  expect(gaps.filter((gap) => gap.code === "COURSE_MEETINGS").map((gap) => gap.projectId).sort()).toEqual(["dsc520"]);
  expect(gaps.some((gap) => gap.code === "DATE_UNDATED")).toBe(false);
});

// The real account, 2026-10-15: the same TBD row came back under three wordings and twice in one batch (once from the file, once from the
// reply 「还不知道」), the answer was never read back, and two to four identical cards sat on 待确认 that no answer could clear.
test("an undated item is asked once whatever its wording, and not again once answered or given a day", () => {
  expect(undatedKey("期末课程项目报告截止")).toBe(undatedKey("提交 ECE 555 期末课程项目报告"));
  expect(undatedKey("ECE 555 期末课程项目报告截止")).toBe("期末课程项目报告");
  const undated = [
    { project: "ece555", kind: "project_due", title: "ECE 555 期末课程项目报告截止" },
    { project: "ece555", kind: "project_due", title: "ECE 555 期末课程项目报告截止" },
    { project: "ece555", kind: "project_due", title: "提交 ECE 555 期末课程项目报告" }];
  const gaps = profileGaps({ ...base, undated }).filter((gap) => gap.code === "DATE_UNDATED");
  expect(gaps).toHaveLength(1);
  const reply = `【${gaps[0]!.question.text}】选择：还不知道`;
  const [answer] = answeredGapFacts(reply, gaps);
  expect(answer).toMatchObject({ projectId: "ece555", value: expect.stringContaining("还不知道") });
  const facts = [...base.facts, { identityId: "research", projectId: "ece555", slot: answer!.slot, value: answer!.value, status: "confirmed" }];
  expect(profileGaps({ ...base, undated, facts }).some((gap) => gap.code === "DATE_UNDATED")).toBe(false);
  // An answer recorded under an older question id still counts: it names the item.
  const old = [...base.facts, { identityId: "research", projectId: "ece555", slot: "undated_6uyhx6",
    value: "「ECE 555」的「ECE 555 期末课程项目报告截止」文件里写的是待定，不是日期。还不知道", status: "confirmed" }];
  expect(profileGaps({ ...base, undated, facts: old }).some((gap) => gap.code === "DATE_UNDATED")).toBe(false);
  // A later batch that dates it settles it too.
  expect(profileGaps({ ...base, undated, datedItems: [{ project: "ECE 555", title: "ECE 555 期末项目报告截止" }, { project: "ece555", title: "期末课程项目报告" }] })
    .some((gap) => gap.code === "DATE_UNDATED")).toBe(false);
});

test("a course whose class times the person said are not fixed is not asked when it meets again (W-268)", () => {
  const input: ProfileGapInput = { ...base, projects: [...base.projects, { id: "ece548", identityId: "research", name: "ECE 548" }], facts: [...base.facts, grading("ece548")] };
  expect(profileGaps(input).some((gap) => gap.code === "COURSE_MEETINGS" && gap.projectId === "ece548")).toBe(true);
  const said = { identityId: "research", projectId: "ece548", slot: "class_note", value: "8–21 点之间不固定", status: "confirmed" };
  expect(profileGaps({ ...input, facts: [...input.facts, said] }).some((gap) => gap.code === "COURSE_MEETINGS" && gap.projectId === "ece548")).toBe(false);
});

test("a course the calendar repeats every week is not asked when it meets, and the question never asks where", () => {
  const input: ProfileGapInput = { ...base, projects: [...base.projects, { id: "ece548", identityId: "research", name: "ECE 548" }], facts: [...base.facts, grading("ece548")] };
  expect(profileGaps(input).find((gap) => gap.code === "COURSE_MEETINGS")!.question.text).toBe("「ECE 548」每周什么时候上课？");
  expect(profileGaps({ ...input, calendarRecurring: ["ECE548 Lecture"] }).some((gap) => gap.code === "COURSE_MEETINGS")).toBe(false);
});

test("a line with no goal chosen gets its candidates as a question of the round, and the taps choose it", () => {
  const gaps = profileGaps({ ...base, goalPickers: [{ lineId: "research", candidates: ["严谨", "器件物理", "严谨", " ", "独立"] }, { lineId: "startup", candidates: ["稳"] }] });
  const goal = gaps.filter((gap) => gap.code === "LINE_GOAL");
  expect(goal.map((gap) => gap.identityId)).toEqual(["research"]);
  expect(goal[0]).toMatchObject({ blocking: true, question: { id: "gap-goal-research", kind: "multi", allowOther: true } });
  // Fewer than three candidates (startup's one) is not a choice yet: the dialogue asks for the words first.
  expect(goal[0]!.question.options.map((option) => option.label)).toEqual(["严谨", "器件物理", "独立"]);
  expect(goal[0]!.question.text).toContain("长期目标");
  const reply = `【${goal[0]!.question.text}】选择：器件物理；严谨。补充：能独立立项`;
  expect(answeredGapFacts(reply, gaps)).toEqual([expect.objectContaining({ slot: "", goal: { lineId: "research", parts: ["严谨", "器件物理", "能独立立项"] } })]);
  expect(answeredGapFacts(`【${goal[0]!.question.text}】选择：`, gaps)).toEqual([]);
});

test("a project whose deadline is asked gets no second question about the same date being undecided", () => {
  const projects = [{ id: "apply", identityId: "research", name: "申请材料" }];
  const undated = [{ project: "apply", kind: "deadline", title: "申请材料提交截止" }];
  const codes = profileGaps({ ...base, projects, undated }).filter((gap) => gap.projectId === "apply").map((gap) => gap.code);
  expect(codes).toEqual(["PROJECT_DEADLINE"]);
  // Once the deadline is known (or said to be none), the undecided date of one of its parts is asked on its own.
  const facts = [...base.facts, { identityId: "research", projectId: "apply", slot: "deadline", value: "12 月中旬前", status: "confirmed" }];
  expect(profileGaps({ ...base, projects, undated, facts }).filter((gap) => gap.projectId === "apply").map((gap) => gap.code)).toEqual(["DATE_UNDATED"]);
});

