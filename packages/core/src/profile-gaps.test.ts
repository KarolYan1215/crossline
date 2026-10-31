import { describe, expect, test } from "vitest";
import { answeredGapFacts, gapCoveredBy, isCourse, mergeFacts, profileGaps, screenAssumption, screenedNote, screenQuestions, undatedKey, type ProfileGapInput } from "./profile-gaps";
import { questionKind } from "./onboarding-turn-schema";

const identities = [{ id: "research", label: "科研" }, { id: "startup", label: "创业" }];
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
});

// Found in the sponsor models' sample interviews (2026-10-18): every candidate asked a project's deadline in its own words, and the app's
// 「「X」有截止日期吗？」 was added on top — the model had said 期限 or 目标时间, or filed the question under the line only.
test("the app's deadline question is not added when the model already asked that deadline in its own words", () => {
  const gaps = profileGaps({ identities: [{ id: "startup", label: "创业" }, { id: "media", label: "自媒体" }, { id: "research", label: "科研" }],
    projects: [{ id: "tool", identityId: "startup", name: "研究生排期小工具" }, { id: "xhs", identityId: "media", name: "小红书科研日常" },
      { id: "paper", identityId: "research", name: "忆阻器阵列仿真会议论文" }, { id: "review", identityId: "research", name: "综述写作" }],
    facts: [] }).filter((gap) => gap.code === "PROJECT_DEADLINE");
  const ask = (identityId: string, projectId: string, text: string) => ({ identityId, projectId, text });
  const gap = (projectId: string) => gaps.find((item) => item.projectId === projectId)!;
  // Words other than 截止, under the line only.
  expect(gapCoveredBy(gap("tool"), [ask("startup", "", "创业这条线，有没有给自己定过期限？")], gaps)).toBe(true);
  expect(gapCoveredBy(gap("xhs"), [ask("media", "", "小红书做到 1 万粉丝有目标时间吗？")], gaps)).toBe(true);
  // Naming the project under another id.
  expect(gapCoveredBy(gap("tool"), [ask("startup", "paiqi", "排期小工具项目有无截止或目标时间点？")], gaps)).toBe(true);
  expect(gapCoveredBy(gap("paper"), [ask("research", "", "会议论文的精确投稿日期是哪一天？")], gaps)).toBe(true);
  // A line with two projects: a deadline question naming neither covers neither; another line's question never covers.
  expect(gapCoveredBy(gap("review"), [ask("research", "", "科研这条线未来半年有哪些必须优先的截止？")], gaps)).toBe(false);
  expect(gapCoveredBy(gap("tool"), [ask("media", "", "小红书有目标时间吗？")], gaps)).toBe(false);
  // Not about a deadline.
  expect(gapCoveredBy(gap("tool"), [ask("startup", "tool", "研究生排期小工具现在做到哪一步了？")], gaps)).toBe(false);
});

test("a round stored with both questions shows the model's and drops the app's duplicate", () => {
  const question = (id: string, identityId: string, projectId: string, text: string) => ({ id, text, kind: "single", identityId, projectId, options: [] });
  const round = [question("q1", "media", "", "小红书 1 万粉丝的目标有时间线吗？"), question("gap-deadline-xhs", "media", "xhs", "「小红书科研日常」有截止日期吗？"),
    question("gap-deadline-tool", "startup", "tool", "「研究生排期小工具」有截止日期吗？")];
  const screen = screenQuestions(round, { projects: [], meetings: [] });
  expect(screen.keep.map((item) => item.id)).toEqual(["q1", "gap-deadline-tool"]);
  expect(screen.screened).toEqual([expect.objectContaining({ reason: "duplicate" })]);
  expect(screen.screened.map(screenAssumption).filter(Boolean)).toEqual([]);
});

// Found walking the app as an invitee (2026-10-15): the interview asked when 「RBT 610 期末项目」 meets, and for 「大致日期」 of a weekly
// homework deadline the model had filed as undated.
test("a course's parts and weekly deadlines are not asked as meetings or undated dates", () => {
  const input: ProfileGapInput = { ...base, meetings: ["rbt610"], dated: ["rbt610", "rbt610-final", "dsc520"],
    projects: [{ id: "rbt610", identityId: "research", name: "RBT 610 Robot Perception" }, { id: "rbt610-final", identityId: "research", name: "RBT 610 期末项目" },
      { id: "dsc520", identityId: "research", name: "DSC 520" }, { id: "rbt611", identityId: "research", name: "RBT 611" }],
    undated: [{ project: "dsc520", title: "DSC 520 每周作业截止", kind: "homework" }] } as ProfileGapInput;
  const gaps = profileGaps(input);
  expect(gaps.filter((gap) => gap.code === "COURSE_MEETINGS").map((gap) => gap.projectId).sort()).toEqual(["dsc520", "rbt611"]);
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

test("a course the calendar repeats every week is not asked when it meets, and the question never asks where", () => {
  const input: ProfileGapInput = { ...base, projects: [...base.projects, { id: "ece548", identityId: "research", name: "ECE 548" }] };
  expect(profileGaps(input).find((gap) => gap.code === "COURSE_MEETINGS")!.question.text).toBe("「ECE 548」每周什么时候上课？");
  expect(profileGaps({ ...input, calendarRecurring: ["ECE548 Lecture"] }).some((gap) => gap.code === "COURSE_MEETINGS")).toBe(false);
});

test("questions that are not the person's to answer are kept from them; a calendar's recurrence becomes an assumption", () => {
  const ask = (id: string, text: string, projectId = "") => ({ id, text, kind: "single", identityId: "research", projectId, options: [] });
  const round = [
    ask("q-ece548-location", "ECE 548 每周上课地点？", "ece548"),
    ask("q-ece548-schedule", "ECE 548 每周固定上课的星期、起止时间和地点？", "ece548"),
    ask("q-calendar-events", "日历中的两项活动，哪些属于持续安排？"),
    ask("q-one-on-one", "你每周二的导师 1V1 通常几点结束？"),
    ask("q-ece555-class", "ECE 555 每周几上课？"),
    ask("gap-meetings-ece548", "「ECE 548」每周什么时候上课？", "ece548")];
  const screen = screenQuestions(round, { projects: [{ id: "ece548", name: "ECE 548" }, { id: "ece555", name: "ECE 555" }], meetings: ["ece548"] });
  expect(screen.keep.map((question) => question.id)).toEqual(["q-one-on-one", "q-ece555-class", "gap-meetings-ece548"]);
  expect(screen.screened.map((item) => [item.question.id, item.reason])).toEqual([
    ["q-ece548-location", "location"], ["q-ece548-schedule", "known_schedule"], ["q-calendar-events", "calendar_inferable"]]);
  // The calendar decides class times too.
  expect(screenQuestions([round[4]!], { projects: [{ id: "ece555", name: "ECE 555" }], meetings: [], calendarRecurring: ["ECE 555 Lecture"] }).keep).toEqual([]);
  expect(screen.screened.map(screenAssumption).filter(Boolean)).toEqual([expect.objectContaining({ identityId: "research",
    slot: expect.stringMatching(/^assumed_/), value: expect.stringMatching(/^假设：日历中的两项活动/) })]);
  expect(screenedNote(screen.screened)).toContain("「ECE 548 每周上课地点？」（只问地点，地点不影响排程）");
  expect(screenedNote([])).toBe("");
});

test("a question that asks for several things takes several answers; one with exclusive options stays single", () => {
  expect(questionKind({ kind: "single", text: "ECE 548 本学期最重要的目标？" })).toBe("multi");
  expect(questionKind({ kind: "single", text: "哪些结果可以证明 ECE 548 正在取得进展？" })).toBe("multi");
  expect(questionKind({ kind: "single", text: "ECE 548 的目标成绩？" })).toBe("single");
  expect(questionKind({ kind: "single", text: "「ECE 548」有截止日期吗？" })).toBe("single");
  expect(questionKind({ kind: "free", text: "还有哪些？" })).toBe("free");
  // Every question the app builds itself has options that exclude each other.
  const all = profileGaps({ ...base, projects: [...base.projects, { id: "x", identityId: "startup", name: "X" }],
    undated: [{ project: "ece555", kind: "exam", title: "期末" }], unfiled: [{ id: "d", fileName: "a.pdf" }], portrait: { written: true, confirmed: false } });
  expect(all.length).toBeGreaterThan(4);
  expect(all.every((gap) => gap.question.kind === "single" && questionKind(gap.question) === "single")).toBe(true);
});

test("a step question the task's own files answer is recognised; one only the person knows is not", async () => {
  const { readableFromMaterial } = await import("./profile-gaps");
  for (const text of ["作业 3 题面及题目数？", "作业提交方式？", "协作与 AI 使用规则？", "评分标准是什么？", "报告的字数要求？"]) expect(readableFromMaterial(text)).toBe(true);
  for (const text of ["当前完成状态？", "当前 A− 安全分数线？", "哪几讲已经掌握？"]) expect(readableFromMaterial(text)).toBe(false);
});

// W-8: the left column offers a line's goal as attributes to pick, and the round asked 「希望长期保持哪些特质」 again.
test("a round question asking a line's long-term goal is screened once the left column offers that line's candidates", () => {
  const q = (id: string, text: string, identityId = "") => ({ id, text, projectId: "", identityId });
  const round = [q("q1", "希望长期保持哪些特质？", "startup"), q("q2", "想成为什么样的研究者？", "research"), q("q3", "长期目标是什么？"),
    q("q4", "这周最卡的是哪件事？", "startup")];
  const screen = screenQuestions(round, { projects: [], meetings: [], goalPickerLines: ["startup"] });
  expect(screen.screened.map((item) => [item.question.id, item.reason])).toEqual([["q1", "goal_picker"], ["q3", "goal_picker"]]);
  expect(screen.keep.map((item) => item.id)).toEqual(["q2", "q4"]);
  // No candidates yet: the question is how the interview learns the goal, so it stays.
  expect(screenQuestions(round, { projects: [], meetings: [] }).keep).toHaveLength(4);
});

test("a line with no goal chosen gets its candidates as a question of the round, and the taps choose it", () => {
  const gaps = profileGaps({ ...base, goalPickers: [{ lineId: "research", candidates: ["严谨", "器件物理", "严谨", " "] }, { lineId: "startup", candidates: [] }] });
  const goal = gaps.filter((gap) => gap.code === "LINE_GOAL");
  expect(goal.map((gap) => gap.identityId)).toEqual(["research"]);
  expect(goal[0]).toMatchObject({ blocking: true, question: { id: "gap-goal-research", kind: "multi", allowOther: true } });
  expect(goal[0]!.question.options.map((option) => option.label)).toEqual(["严谨", "器件物理"]);
  expect(goal[0]!.question.text).toContain("长期目标");
  const reply = `【${goal[0]!.question.text}】选择：器件物理；严谨。补充：能独立立项`;
  expect(answeredGapFacts(reply, gaps)).toEqual([expect.objectContaining({ slot: "", goal: { lineId: "research", parts: ["严谨", "器件物理", "能独立立项"] } })]);
  expect(answeredGapFacts(`【${goal[0]!.question.text}】选择：`, gaps)).toEqual([]);
});
