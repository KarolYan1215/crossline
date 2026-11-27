import { expect, test } from "vitest";
import { checkChecklistVerdicts, interviewChecklist, interviewOwnedOpen, judgedItems, partsUncovered, portraitFingerprint, readChecklistVerdicts, readyToStart,
  type ChecklistInput, type ChecklistVerdict } from "./index";

/** A verdict the model gave against the ledger snapshot (2026-11-25), citing the person's reply. */
const said = (id: string, status: ChecklistVerdict["status"] = "answered", note = ""): ChecklistVerdict =>
  ({ id, status, basis: status === "answered" || status === "partial" ? [{ ref: "reply-2", quote: "本人原话" }] : [], note });



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
    { identityId: "person", projectId: "", slot: "method_exam_prep", status: "confirmed", sourceRef: "reply-6" },
    { identityId: "research", projectId: "ece555", slot: "grading", status: "confirmed", sourceRef: "src-1" },
    { identityId: "research", projectId: "ece555", slot: "goal", status: "confirmed", sourceRef: "reply-2" },
    { identityId: "research", projectId: "ece555", slot: "evidence", status: "confirmed", sourceRef: "reply-2" },
    { identityId: "research", projectId: "", slot: "near_term", status: "confirmed", sourceRef: "reply-7", value: "11/24 前提交 ECE 555 HW4" }],
  projects: [{ id: "ece555", identityId: "research", name: "ECE 555" }, { id: "research-default", identityId: "research", name: "研究者" }],
  dates: [{ project: "ECE 555", kind: "class", recurring: true, pending: false, sourceRef: "src-2" }, { project: "ECE 555", kind: "exam", recurring: false, pending: false, sourceRef: "src-1" }],
  availability: true, unfiledFiles: 0, portraitConfirmed: true,
  // Three parts written from the person's sentences (structure); how they work, the attention shares, the say–do weights and the
  // project's details only the model's verdict settles.
  groundedSections: ["situation", "compass", "energy"],
  verdicts: { "portrait:method": said("portrait:method"), "portrait:allocation": said("portrait:allocation"), "portrait:saydo": said("portrait:saydo"),
    "project:ece555": said("project:ece555") }
};

test("a complete record ticks every item, the portrait included", () => {
  const items = interviewChecklist(full);
  expect(items.filter((item) => !item.done)).toEqual([]);
  expect(items.map((item) => item.id)).toEqual(["portrait_fields", "portrait_synthesis", "portrait_grounded", "portrait_confirmed", "start_line", "start_milestone", "line_desc:research", "line_goal:research",
    "hard_schedule:research", "availability", "line_project:research", "near_term:research", "project:ece555", "project_course:ece555", "files_filed"]);
});

test("a portrait written only from inferences is not finished, and what is missing is named", () => {
  const items = interviewChecklist({ ...full, groundedSections: [], verdicts: {}, profile: { ...full.profile, trueNorth: "", energyMap: [] } });
  expect(items.find((item) => item.id === "portrait_grounded")).toMatchObject({ done: false, detail: "尚无本人依据：现状与真问题、工作观与人生观、精力：充电与耗电、擅长与喜欢、做事方法、各主线现在的注意力占比、说与做五项各有多重要" });
  expect(items.find((item) => item.id === "portrait_fields")?.detail).toContain("正北");
  // The fields are the report's to write (deferred); the parts, each with its own question, are the interview's.
  expect(interviewOwnedOpen(items).map((item) => item.id)).toEqual(["portrait_grounded"]);
  expect(judgedItems(items).find((item) => item.id === "portrait:energy")?.detail).toBe("最近哪几件事做完更有劲，哪几件做完很累？其中哪些是你擅长的，哪些是你喜欢的？");
});

test("what only the person can settle is theirs, and does not count as the interview's", () => {
  const items = interviewChecklist({ ...full, lines: [{ ...full.lines[0]!, goals: [] }], portraitConfirmed: false, unfiledFiles: 2,
    dates: [...full.dates, { project: "ECE 548", kind: "exam", recurring: false, pending: true, sourceRef: "src-4" }] });
  const open = items.filter((item) => !item.done);
  expect(open.map((item) => [item.id, item.owner])).toEqual([["portrait_confirmed", "person"], ["line_goal:research", "person"], ["dates_confirmed", "person"], ["files_filed", "person"]]);
  expect(interviewOwnedOpen(items)).toEqual([]);
});

// 2026-11-25 (IR-028): a graded project is one with its grading on record; a name shaped like a course code («ECE 555») no longer makes one,
// so whether it is judged and meets at fixed times is the interview's to ask.
test("a graded project needs its fixed times, a hard line its fixed schedule; a confirmation lasts only while the portrait is the same", () => {
  const items = interviewChecklist({ ...full, dates: full.dates.filter((entry) => !entry.recurring) });
  expect(items.find((item) => item.id === "project_course:ece555")?.detail).toBe("缺：固定时间");
  expect(interviewChecklist({ ...full, facts: full.facts.filter((fact) => fact.slot !== "grading") }).some((item) => item.id === "project_course:ece555")).toBe(false);
  expect(items.find((item) => item.id === "hard_schedule:research")?.done).toBe(false);
  expect(portraitFingerprint({ portrait: "a b", coreConflict: "c" })).toBe(portraitFingerprint({ portrait: "ab", coreConflict: "c" }));
  expect(portraitFingerprint({ portrait: "a" })).not.toBe(portraitFingerprint({ portrait: "b" }));
});

// 2026-11-25 (「访谈账本驱动」): whether the person's words settle an item is the model's verdict against the ledger; the 「假设：」 prefix
// and the slot-name patterns that read fact values are gone.
test("a partial verdict keeps the item open and says what is missing; not_applicable settles it; a fact's wording settles nothing", () => {
  const without = { ...full, verdicts: { "portrait:allocation": said("portrait:allocation"), "portrait:saydo": said("portrait:saydo") } };
  const method = (input: ChecklistInput) => interviewChecklist(input).find((item) => item.id === "portrait_grounded")!;
  expect(method(without)).toMatchObject({ done: false, detail: "尚无本人依据：做事方法" });
  expect(method({ ...without, facts: [...without.facts, { identityId: "person", projectId: "", slot: "method_learning", status: "inferred", sourceRef: "", value: "假设：先做往年题" }] }).done).toBe(false);
  expect(method({ ...without, verdicts: { ...without.verdicts, "portrait:method": said("portrait:method", "partial", "只说了考试怎么准备，学新东西还没说") } }).done).toBe(false);
  expect(method({ ...without, verdicts: { ...without.verdicts, "portrait:method": said("portrait:method") } }).done).toBe(true);
  const undated = { ...full, dates: full.dates.filter((entry) => !entry.recurring) };
  const schedule = (verdict?: ChecklistVerdict) => interviewChecklist({ ...undated, verdicts: { ...full.verdicts, ...(verdict ? { [verdict.id]: verdict } : {}) } })
    .find((item) => item.id === "hard_schedule:research")!;
  expect(schedule(said("hard_schedule:research", "partial", "只知道周二没课，其余几天的时间还没说"))).toMatchObject({ done: false, detail: "只知道周二没课，其余几天的时间还没说" });
  expect(schedule(said("hard_schedule:research", "not_applicable", "本人说这条线每周没有固定要占的时间")).done).toBe(true);
});

test("可开始标准（D10，2026-11-22）：只剩「至少一条主线」与「至少一个里程碑」；画像、日程、截止都不再挡开始", () => {
  const items = interviewChecklist({ ...full, portraitConfirmed: false, profile: {}, availability: false, dates: [],
    facts: full.facts.filter((fact) => fact.slot !== "near_term"), lines: [{ ...full.lines[0]!, goals: [] }] });
  expect(items.filter((item) => item.start).map((item) => item.id)).toEqual(["start_line", "start_milestone"]);
  expect(readyToStart(items)).toBe(true);
  expect(items.find((item) => item.id === "portrait_fields")?.done).toBe(false);
  expect(items.find((item) => item.id === "availability")).toMatchObject({ done: false, owner: "interview" });
  expect(items.find((item) => item.id === "availability")?.start).toBeUndefined();
  // No line: nothing to schedule on.
  expect(readyToStart(interviewChecklist({ ...full, lines: [] }))).toBe(false);
});

test("a milestone is one on the board, a current project of a line, or a `milestone` fact the person confirmed; a guess is not", () => {
  const bare = { ...full, projects: [{ id: "research-default", identityId: "research", name: "研究者" }], facts: full.facts.filter((fact) => fact.projectId !== "ece555") };
  const milestone = (input: ChecklistInput) => interviewChecklist(input).find((item) => item.id === "start_milestone")!;
  expect(milestone(bare)).toMatchObject({ done: false, start: true });
  expect(milestone(bare).ask).toBeTruthy();
  expect(readyToStart(interviewChecklist(bare))).toBe(false);
  expect(milestone({ ...bare, milestones: 1 }).done).toBe(true);
  expect(milestone(full).done).toBe(true);
  const fact = (status: string, sourceRef: string) => ({ identityId: "research", projectId: "", slot: "milestone", status, sourceRef, value: "明年三月投稿" });
  expect(milestone({ ...bare, facts: [...bare.facts, fact("confirmed", "reply-4")] }).done).toBe(true);
  expect(milestone({ ...bare, facts: [...bare.facts, fact("inferred", "")] }).done).toBe(false);
});

// The fixed schedule: a recurring date on record (structure) or the model's verdict. The weekday, clock and 「不固定」 patterns over fact
// values are gone (2026-11-25): 「早八点到晚九点」 and 「8–21 点之间不固定」 are the model's to read, with the reply it quotes.
test("a fixed schedule is a recurring date on record or the model's verdict; a fact's words alone settle nothing", () => {
  const undated = { ...full, dates: full.dates.filter((entry) => !entry.recurring) };
  const done = (input: ChecklistInput) => interviewChecklist(input).find((item) => item.id === "hard_schedule:research")?.done;
  const fact = { identityId: "research", projectId: "", slot: "fixed_schedule", status: "confirmed", sourceRef: "reply-7", value: "周一到周五按课表走，课在早八点到晚九点之间" };
  expect(done({ ...undated, facts: [...undated.facts, fact] })).toBe(false);
  expect(done({ ...undated, verdicts: { ...full.verdicts, "hard_schedule:research": said("hard_schedule:research") } })).toBe(true);
  expect(done(full)).toBe(true);
  // A recurring date under no project counts for the only hard line; with two hard lines it stands for neither.
  const loose = { ...undated, dates: [...undated.dates, { project: "上课", kind: "class", recurring: true, pending: false, sourceRef: "reply-13" }] };
  expect(done(loose)).toBe(true);
  expect(done({ ...loose, lines: [...loose.lines, { id: "venture", label: "创业者", hard: true, goals: ["x"] }] })).toBe(false);
});

test("每条主线至少一个当前项目且知道截止；「没有截止」由模型对着账本判定", () => {
  const undated = { ...full, dates: full.dates.filter((entry) => entry.recurring) };
  expect(interviewChecklist(undated).find((item) => item.id === "line_project:research")).toMatchObject({ done: false, owner: "interview" });
  const none = { ...undated, verdicts: { ...full.verdicts, "line_project:research": said("line_project:research") } };
  expect(interviewChecklist(none).find((item) => item.id === "line_project:research")?.done).toBe(true);
  // A `no_deadline` fact's wording is no longer read here.
  const fact = { ...undated, facts: [...undated.facts, { identityId: "research", projectId: "ece555", slot: "no_deadline", status: "confirmed", sourceRef: "reply-4", value: "没有截止" }] };
  expect(interviewChecklist(fact).find((item) => item.id === "line_project:research")?.done).toBe(false);
  // 只有 `-default` 项目不算「当前项目」。
  const onlyDefault = { ...full, projects: full.projects.filter((project) => project.id.endsWith("-default")) };
  expect(interviewChecklist(onlyDefault).find((item) => item.id === "line_project:research")?.detail).toBe("尚无当前项目");
  // 本人说「这条线先不规划」（应用自己的问题记为 confirmed 的 `skipped`）就是这一项的答案；推断的不算（2026-10-20 极简版评测）。
  const skipped = (status: string) => ({ ...onlyDefault, facts: [...onlyDefault.facts,
    { identityId: "research", projectId: "", slot: "skipped", status, sourceRef: "reply-6", value: "有，但现在不想规划" }] });
  expect(interviewChecklist(skipped("confirmed")).find((item) => item.id === "line_project:research")?.done).toBe(true);
  expect(interviewChecklist(skipped("inferred")).find((item) => item.id === "line_project:research")?.done).toBe(false);
});

// The interview rewrites the portrait every round; an exact match lost the person's 「符合」 to a reworded clause and asked again, every
// round, on the real account (2026-10-15).
test("a confirmed portrait stays confirmed through a rewording, not through a rewrite", async () => {
  const { portraitStillConfirmed } = await import("./index");
  const before = { portrait: "以神经形态软硬件协同博士训练为底座，同时追求研究型公司、公众影响和财富选择权的高自主多主线知识工作者。",
    coreConflict: "技术创业被视为价值上的最高优先级，研究者又是未来12–24个月不可移动的日历底座；四条主线均被赋予极致与复利期待，但潜在工作容量尚未形成清晰的可持续边界。",
    problem: "真问题不是缺少方向或能力，而是如何在研究者硬约束下，把快速启动、跨域探索和高压驱动转化为少数持续收敛、外部可验证且跨主线复用的成果。" };
  const reworded = { ...before, coreConflict: "技术创业被视为价值上的最高优先级，研究者又是未来 12–24 个月不可移动的日历底座；四条主线均承载极致与复利期待，但潜在工作容量尚未与固定安排、恢复需求和持续收敛能力分开。",
    problem: before.problem.replace("能力", "投入意愿") };
  const fingerprint = portraitFingerprint(before);
  expect(portraitStillConfirmed(fingerprint, before)).toBe(true);
  expect(portraitStillConfirmed(fingerprint, reworded)).toBe(true);
  expect(portraitStillConfirmed(fingerprint, { portrait: "一位专注单一赛道的独立摄影师。", coreConflict: "收入不稳定与创作自由之间的拉扯。", problem: "如何让作品被更多人看到。" })).toBe(false);
  expect(portraitStillConfirmed(undefined, before)).toBe(false);
});

// 2026-10-15 walkthrough: every answer was in under slot names the checklist did not know, and the interview could not finish. Since
// 2026-11-25 no slot name is read: a project's details are the model's verdict, a course's times a recurring date or the verdict.
test("a project's details are the model's verdict, and a graded project's times a recurring date or the verdict", () => {
  const items = interviewChecklist({ ...full, verdicts: {}, dates: [{ project: "ECE 555", kind: "exam", recurring: false, pending: false, sourceRef: "src-1" }] });
  expect(items.find((item) => item.id === "project:ece555")).toMatchObject({ done: false, deferred: true, detail: "目标、截止与进展证据待确认" });
  expect(items.find((item) => item.id === "project_course:ece555")?.detail).toBe("缺：固定时间");
  const judged = interviewChecklist({ ...full, verdicts: { "project:ece555": said("project:ece555"), "project_course:ece555": said("project_course:ece555") },
    dates: [{ project: "ECE 555", kind: "exam", recurring: false, pending: false, sourceRef: "src-1" }] });
  expect(judged.filter((item) => item.id.endsWith(":ece555")).map((item) => [item.id, item.done])).toEqual([["project:ece555", true], ["project_course:ece555", true]]);
});

// 2026-11-12: the tiers are gone; a project's details wait for its planning.
test("a project's details wait for planning", () => {
  const sparse = { ...full, facts: full.facts.filter((fact) => fact.projectId !== "ece555" || fact.slot === "grading"), dates: [] };
  expect(Object.fromEntries(interviewChecklist(sparse)
    .filter((item) => item.id.endsWith(":ece555") && item.id.startsWith("project")).map((item) => [item.id, Boolean(item.deferred)])))
    .toEqual({ "project:ece555": true, "project_course:ece555": true });
});

test("the portrait's parts rest on a section written from the person's sentences or on the model's verdict; slot names count for nothing", () => {
  const person = (slot: string) => ({ identityId: "person", projectId: "", slot, status: "confirmed", sourceRef: "reply-3", value: "本人原话" });
  const bare = { ...full, groundedSections: [], verdicts: {}, facts: [...full.facts.filter((fact) => fact.identityId !== "person"),
    person("near_risk"), person("work_motive"), person("flow_scene"), person("method_learning")] };
  const grounded = (input: ChecklistInput) => interviewChecklist(input).find((item) => item.id === "portrait_grounded")!;
  expect(grounded(bare).done).toBe(false);
  expect(grounded({ ...bare, groundedSections: ["situation", "compass", "energy"] }).detail).toBe("尚无本人依据：做事方法、各主线现在的注意力占比、说与做五项各有多重要");
  const verdicts = Object.fromEntries(["situation", "compass", "energy", "method", "allocation", "saydo"].map((part) => [`portrait:${part}`, said(`portrait:${part}`)]));
  expect(grounded({ ...bare, verdicts })).toMatchObject({ done: true, detail: "" });
  // Each part is judged on its own: the snapshot lists the parts, not the summary item.
  expect(judgedItems(interviewChecklist(bare)).map((item) => item.id).filter((id) => id.startsWith("portrait"))).toEqual(["portrait:situation", "portrait:compass", "portrait:energy",
    "portrait:method", "portrait:allocation", "portrait:saydo"]);
});

// 2026-11-27 (docs/plans/condense-1127.md A3): the numbers no scale measures are covered by the interview; the interview is not complete
// until the model settles them, and a part asked and still unknown settles as such (the report then leaves its number null).
test("the attention shares and the say–do weights are parts of the portrait the model settles by verdict; the interview waits for them", () => {
  const open = { ...full, verdicts: { "portrait:method": said("portrait:method"), "project:ece555": said("project:ece555") } };
  const grounded = (input: ChecklistInput) => interviewChecklist(input).find((item) => item.id === "portrait_grounded")!;
  expect(grounded(open)).toMatchObject({ done: false, sections: ["allocation", "saydo"], ask: expect.stringContaining("注意力") });
  expect(interviewOwnedOpen(interviewChecklist(open)).map((item) => item.id)).toEqual(["portrait_grounded"]);
  const partial = { ...open, verdicts: { ...open.verdicts, "portrait:allocation": said("portrait:allocation", "partial", "只说了研究占大头") } };
  expect(grounded(partial).parts!.find((part) => part.id === "portrait:allocation")!.done).toBe(false);
  const settled = { ...open, verdicts: { ...open.verdicts, "portrait:allocation": said("portrait:allocation"), "portrait:saydo": said("portrait:saydo", "not_applicable", "本人问过后说不知道") } };
  expect(grounded(settled).done).toBe(true);
  expect(interviewChecklist(settled).filter((item) => !item.done)).toEqual([]);
});

test("no deep part holds the start any more (D10): the person decides when to start", () => {
  const order = ["narrative", "compass", "energy", "situation", "orientation", "lines"];
  expect(partsUncovered({ stageOrder: order, stagesSeen: [], items: interviewChecklist({ ...full, groundedSections: [], facts: [] }) })).toEqual([]);
});

test("near-term work is still asked (2026-11-20): a thing named, a 「没有」, or a skipped line settles it; an account already started is not asked", () => {
  const without = { ...full, facts: full.facts.filter((fact) => fact.slot !== "near_term") };
  const near = (input: ChecklistInput) => interviewChecklist(input).find((item) => item.id === "near_term:research")!;
  expect(near(without)).toMatchObject({ done: false, owner: "interview" });
  expect(near(without).ask).toContain("这周到下周");
  const none = { ...without, facts: [...without.facts, { identityId: "research", projectId: "", slot: "near_term", status: "confirmed", sourceRef: "reply-8", value: "没有" }] };
  expect(near(none).done).toBe(true);
  // A guess is not the person's word.
  const guessed = { ...without, facts: [...without.facts, { identityId: "research", projectId: "", slot: "near_term", status: "inferred", sourceRef: "", value: "写论文" }] };
  expect(near(guessed).done).toBe(false);
  expect(near({ ...without, nearTermSettled: { research: true } }).done).toBe(true);
});

test("a verdict stands only on words found where it says: a listed id, a status of the four, a verbatim quote, never a disclosure's reply", () => {
  const ids = new Set(["hard_schedule:research", "portrait:method"]);
  const texts = { "reply-3": "工作日 10:00 到 19:30 在公司，周一上午例会。", "reply-5": "大二那段不想再说。", "src-1": "Lecture: Tue/Thu 9:30–10:45" };
  const { accepted, problems } = checkChecklistVerdicts([
    { id: "hard_schedule:research", status: "answered", basis: [{ ref: "reply-3", quote: "工作日 10:00 到 19:30 在公司" }], note: "" },
    { id: "portrait:method", status: "answered", basis: [{ ref: "reply-3", quote: "先做往年题" }], note: "" },
    { id: "portrait:method", status: "partial", basis: [], note: "" },
    { id: "portrait:method", status: "not_applicable", basis: [], note: "" },
    { id: "portrait:method", status: "answered", basis: [{ ref: "reply-5", quote: "大二那段" }], note: "" },
    { id: "line_desc:x", status: "missing", basis: [], note: "" },
    { id: "hard_schedule:research", status: "answered", basis: [{ ref: "src-9", quote: "Lecture" }], note: "" }
  ], { ids, texts, sensitive: new Set(["reply-5"]) });
  expect(accepted.map((verdict) => verdict.id)).toEqual(["hard_schedule:research"]);
  expect(problems).toHaveLength(6);
  expect(problems.join("\n")).toMatch(/不在 reply-3 里[\s\S]*至少引一处[\s\S]*note 写为什么[\s\S]*不作依据[\s\S]*不在快照的清单里[\s\S]*src-9 不存在/u);
});

test("the latest verdict per item stands, over every interview of the workspace", () => {
  const at = (when: string, status: ChecklistVerdict["status"]) => ({ ...said("near_term:research", status, status === "partial" ? "缺一件" : ""), round: 3, at: when });
  const verdicts = readChecklistVerdicts([
    { checklist: { "near_term:research": at("2026-11-25T10:00:00Z", "partial") } },
    { checklist: { "near_term:research": at("2026-11-25T11:00:00Z", "answered"), "bad": { id: "bad", status: "done", at: "2026-11-25T12:00:00Z" } } },
    null, { checklist: "x" }
  ]);
  expect(verdicts).toEqual({ "near_term:research": said("near_term:research") });
});
