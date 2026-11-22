import { courseCodeOf } from "./task-title";
import { METHOD_SLOT } from "./drill-forms";
import type { ProfileModel } from "./onboarding-turn-schema";
import { joinList, tFor, type Locale } from "./i18n";

/**
 * When the interview is finished, as a list anyone can tick (decided 2026-10-08). It used to be the model's own call — 「material rich
 * enough」 — with one code check (every line has a confirmed fact); the person asked for a standard that can be checked, and for the
 * portrait to count as much as the work: a portrait cannot be measured, so its items are proxies (every part written, each part
 * resting on something the person said, and the person saying it fits) rather than a score.
 *
 * Each item is owned by the interview (more questions can settle it) or by the person (only their click can: confirming the portrait,
 * adopting a long-term goal, confirming a batch of dates, saying which project a file belongs to). The interview may not declare
 * itself ready while one of its own items is open; it is finished when every item is.
 */
export type ChecklistItem = {
  id: string;
  group: "画像" | "主线" | "日程" | "项目" | "文件";
  label: string;
  done: boolean;
  /** What is missing, in words, when not done. `group` stays a Chinese key (compared and grouped by); show it with `t(group)`. */
  detail: string;
  owner: "interview" | "person";
  /**
   * The item as a question to the person, in the interview's own voice and with none of the checklist's words (硬约束, 定语): what a round
   * says or asks when this item is what is left. The label stays the system's (2026-10-31: 「完成访谈前还缺：硬约束「上班」的固定日程已收集
   * （上课、组会、值班等每周固定安排尚未收集）」 reached a warehouse manager word for word).
   */
  ask?: string;
  /**
   * One of the two things that must stand before the person starts using the app (D10, 2026-11-22): at least one line and at least one
   * milestone, because scheduling cannot do without them. Everything else — a line's description and goal, the weekly hours, a fixed
   * schedule, a deadline, the near-term work — is still asked, but the person decides when to start (「开始使用」 can be pressed at any
   * time, and the model says what is still thin). The five start items of 2026-10-12 and the scale cards of 2026-10-31 no longer hold it.
   */
  start?: true;
  /**
   * Not the interview's to hold up (2026-10-19, the owner's decision): a project's goal, evidence, grading and class times are worked out
   * from the files and the conversation, and what is still missing is asked later — when its task is planned, or on 待决事项 — instead of
   * in a details stage at the end of the interview. Shown, never counted against finishing.
   */
  deferred?: true;
  /** `portrait_grounded` only: the portrait's parts (`situation`, `compass`, `energy`, `method`) with nothing of the person's on record yet. */
  sections?: string[];
};

export type ChecklistInput = {
  lines: Array<{ id: string; label: string; hard: boolean; goals: string[] }>;
  /** The interview's description of each line (`lines.profiles`), and how many attribute candidates (or, before those, whole goal candidates) it proposed. */
  descriptions: Record<string, { description: string; candidates: number }>;
  profile: Partial<ProfileModel>;
  facts: Array<{ identityId: string; projectId: string; slot: string; status: string; sourceRef: string; value?: string }>;
  projects: Array<{ id: string; identityId: string; name: string }>;
  /** Dated items read from files or replies, with their project and kind, and whether they are still waiting for the person. */
  dates: Array<{ project: string; kind: string; recurring: boolean; pending: boolean; sourceRef: string }>;
  /** A weekly pattern was proposed by the interview, or the person saved their own. */
  availability: boolean;
  /**
   * Lines whose near-term work is settled without the question (2026-11-20, §3.6): the line already has open work on the board, or the
   * person confirmed the start before the item existed — an account already in use is not sent back to the interview for it.
   */
  nearTermSettled?: Record<string, boolean>;
  /** Files only the person can place; null where this is not known (the worker). */
  unfiledFiles: number | null;
  portraitConfirmed: boolean;
  /** Milestones on the board (the store's): one is enough for the start, as a current project or a confirmed `milestone` fact is. */
  milestones?: number | undefined;
  /** The portrait's sections (`situation`, `compass`, `energy`) the extraction wrote from at least one numbered sentence. */
  groundedSections?: string[] | undefined;
  /** The language of each item's label and detail (default Chinese). */
  locale?: Locale | undefined;
};

const confirmedFact = (fact: { status: string; sourceRef: string }) => fact.status === "confirmed" && /^(reply|src)-\d+$/.test(fact.sourceRef);
/**
 * An assumption the interview wrote for what the person could not say (「假设：…」, inferred; decided 2026-10-09: missing information is
 * assumed, not asked about forever). It settles an item so the interview moves on, and the item says it rests on an assumption.
 */
export const ASSUMPTION_PREFIX = /^(假设|assumption|assumed)[：:]/i;
const assumedFact = (fact: { status: string; value?: string }) => fact.status === "inferred" && ASSUMPTION_PREFIX.test(fact.value ?? "");
const settledFact = (fact: { status: string; sourceRef: string; value?: string }) => confirmedFact(fact) || assumedFact(fact);
/**
 * The parts of the portrait the person's own words must stand behind, read from the slots the interview files facts under. Read by
 * meaning: the 2026-11-01 rerun's extraction filed the person's answers as `near_risk`, `one_year_priority`, `work_motive`, `motto` and
 * `worth_day`, and all three people kept this item open to the round limit with every part answered.
 */
const PORTRAIT_PARTS: Array<{ label: string; section: string; slots: RegExp; ask: string }> = [
  { label: "现状与真问题", section: "situation", slots: /problem|situation|status|current|pressure|anxi|worry|constraint|gravity|stage|risk|priorit|change|lever|stuck|block|struggle|concern|fear|conflict|tension|dilemma|trouble|difficult|hard_day|regret|undone|stall/i, ask: "眼下最让你放不下的是哪件事？" },
  { label: "工作观与人生观", section: "compass", slots: /work_view|life_view|true_north|value|meaning|compass|purpose|motive|motivation|motto|worth|good_day|ideal|belief|career|tradeoff|work_choice|work_feeling|good_life|standard|principle|dream|life_goal/i, ask: "做事的时候，你最看重的是什么？" },
  { label: "能量与心流", section: "energy", slots: /flow|energy|drain|charge|anchor|behavio|habit/i, ask: "最近一次做得忘了时间，是在做什么？" },
  // How the person actually works (decided 2026-11-10, the owner: tasks take their form from the goal and the person's own habits, never
  // from an identity template such as 学生 → 订正/错题本/背诵/打卡; habits like these are asked in the interview). Asked in the energy part;
  // no section of the portrait stands for it, so only a fact on record settles it.
  { label: "做事方法", section: "method", slots: METHOD_SLOT, ask: "遇到要准备的考核、要赶的截止，或者要学一样新东西，你平时是怎么做的？" }
];
/** The portrait's written parts, each a field of the working profile. */
const PORTRAIT_FIELDS: Array<[keyof ProfileModel, string]> = [["problem", "真问题"],
  ["workView", "工作观"], ["lifeView", "人生观"], ["trueNorth", "正北"], ["says", "所说想要的"], ["does", "行为在维护的"]];
/**
 * The synthesis (one line and the core conflict) is written by the extraction once the three deep sections are final, after the dialogue
 * ends the interview: no question can settle it, so it never holds the interview (2026-10-19: it was owed by the interview and the
 * person was asked 「完成访谈前还缺：一句话画像、核心矛盾，请补充」).
 */
const SYNTHESIS_FIELDS: Array<[keyof ProfileModel, string]> = [["portrait", "一句话画像"], ["coreConflict", "核心矛盾"]];
const isDefaultProject = (id: string) => /-default$/.test(id);
/** A deadline the person said there is none of: an answer, and as good as a date for starting. */
export const NO_DEADLINE = /没有截止|无截止|不设截止|no deadline/i;
// The slot names the interview actually writes vary (`course_goal`, `progress_evidence`, `class_schedule` on 2026-10-15): read by meaning,
// or an interview that had every answer kept the person in a round with nothing left to ask and a list of what was 「missing」.
const PROJECT_SLOTS: Array<[RegExp, string]> = [[/^goal$|^target|_goal$/, "目标"], [/^deadline$|^date_|_deadline$/, "截止日期"],
  [/^evidence$|_evidence$|^progress/, "进展证据"]];
const MEETING_SLOTS = /^(meeting|class)_?(times?|schedule)$|^no_meetings$|^fixed_class_time$/;
/**
 * A weekly arrangement the person stated in a reply, filed as a fact of the line rather than as a dated item (2026-10-31: 「周日上午
 * 10:00–11:30 送娃去跳舞」 was `fixed_schedule`, and the fixed-schedule item stayed open, so the interview asked for it again and again).
 */
const SCHEDULE_SLOT = /schedule|routine|meeting|class|shift|timetable/i;
const WEEKDAY = /周[一二三四五六日天末]|星期|礼拜|工作日|每天|每晚|每早|weekday|weekend|daily|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i;
// 「早八点到晚九点」 in Chinese numerals is a time too (2026-11-12 replay: a student's class hours said so stayed 「not collected」, and the
// interview asked for her fixed schedule again sixteen rounds after she gave it).
const CLOCK = /\d{1,2}\s*[:：点]|[零一二两三四五六七八九十]{1,3}\s*点|[上下]午|早上|晚上|凌晨|\b\d{1,2}\s?(am|pm)\b/i;
/** A schedule the person could only give as a range or said they cannot pin down: recorded as the range, it settles the item (the Skill). */
const VAGUE_SCHEDULE = /不固定|没有固定|没固定|记不清|说不准|随机|看情况|看课表|no fixed|not sure|varies/i;
/**
 * A schedule slot holds a schedule only when its value says when: a day, a time, or that it cannot be pinned down. Replay 11 (2026-11-14)
 * read the opening card's 「有固定日程的主线：学生」 into `fixed_schedule` with no day or time in it, and the start standard stood at
 * round 8 while her timetable was asked only in round 12.
 */
const statesSchedule = (fact: { slot: string; value?: string; identityId?: string }) => {
  const value = fact.value ?? "";
  if (SCHEDULE_SLOT.test(fact.slot)) return WEEKDAY.test(value) || CLOCK.test(value) || VAGUE_SCHEDULE.test(value);
  // 「8–21 点之间不固定」 under a slot of another name (`course_hours`) is the answer too (W-268: the interview asked 「几点到几点」 again in
  // round 10). Not for a fact of the person's own, whose 「不固定」 is about energy or sleep, not a fixed arrangement.
  return WEEKDAY.test(value) && CLOCK.test(value) || (fact.identityId !== "person" && VAGUE_SCHEDULE.test(value) && (CLOCK.test(value) || WEEKDAY.test(value)));
};
/** What a line is about, said by the person: enough to stand for its description while the extraction has not written one. */
const DESCRIBES_LINE = /^(description|what)$/;
/** A part of a course (its project, an exam): graded and timed through the course itself, not on its own. */
const COURSE_PART = /项目|作业|考试|测验|报告|论文|展示|project|homework|assignment|exam|quiz|report|paper|presentation/i;

export function interviewChecklist(input: ChecklistInput): ChecklistItem[] {
  const t = tFor(input.locale);
  const list = (labels: string[]) => input.locale === "en" ? joinList(input.locale, labels.map((label) => t(label))) : labels.join("、");
  const items: ChecklistItem[] = [];
  const profile = input.profile;
  const missingFields = PORTRAIT_FIELDS.filter(([key]) => !String(profile[key] ?? "").trim()).map(([, label]) => label);
  if (!String(profile.anchor ?? "").trim() && !String(profile.realWant ?? "").trim()) missingFields.push("锚与真正想要的");
  const energy = profile.energyMap ?? [];
  if (energy.length < 3 || !energy.some((item) => item.charge === "charge") || !energy.some((item) => item.charge === "drain")) missingFields.push("能量地图（至少 3 项，含充电与耗电）");
  items.push({ id: "portrait_fields", group: "画像", label: t("画像各部分已写出"), done: !missingFields.length,
    detail: missingFields.length ? t("缺：{{items}}", { items: list(missingFields) }) : "", owner: "interview" });
  const missingSynthesis = SYNTHESIS_FIELDS.filter(([key]) => !String(profile[key] ?? "").trim()).map(([, label]) => label);
  items.push({ id: "portrait_synthesis", group: "画像", label: t("画像综合段已写出"), done: !missingSynthesis.length,
    detail: missingSynthesis.length ? t("整理中：{{items}}", { items: list(missingSynthesis) }) : "", owner: "interview", deferred: true });
  const personFacts = input.facts.filter((fact) => fact.identityId === "person" && settledFact(fact));
  // A part rests on the person's words when a fact of it is on record, or when the extraction wrote its section from numbered sentences
  // (each one a span of a reply or a file): slot names vary run to run, and the 2026-11-01 reruns had 「hard_day」 and 「good_life」.
  const sectioned = new Set(input.groundedSections ?? []);
  const unbacked = PORTRAIT_PARTS.filter((part) => !sectioned.has(part.section) && !personFacts.some((fact) => part.slots.test(fact.slot))).map((part) => part.label);
  const assumedParts = PORTRAIT_PARTS.filter((part) => !sectioned.has(part.section) && !personFacts.some((fact) => confirmedFact(fact) && part.slots.test(fact.slot))).map((part) => part.label)
    .filter((label) => !unbacked.includes(label));
  const unbackedSections = PORTRAIT_PARTS.filter((part) => unbacked.includes(part.label)).map((part) => part.section);
  items.push({ id: "portrait_grounded", group: "画像", label: t("画像每部分都有本人原话或文件为据"), done: !unbacked.length, sections: unbackedSections,
    detail: unbacked.length ? t("尚无本人依据：{{items}}", { items: list(unbacked) }) : assumedParts.length ? t("以假设代替：{{items}}", { items: list(assumedParts) }) : "", owner: "interview",
    ...(unbacked.length ? { ask: t(PORTRAIT_PARTS.find((part) => part.label === unbacked[0])!.ask) } : {}) });
  items.push({ id: "portrait_confirmed", group: "画像", label: t("本人确认画像符合自己"), done: input.portraitConfirmed,
    detail: input.portraitConfirmed ? "" : t("在画像页读完后选「符合」，或说明哪里不对"), owner: "person" });
  // The scale is a page of its own before the first round (2026-11-22) and holds nothing up: the profile_cards start item is gone.

  // The two start items (D10): scheduling needs a line to put work on and a milestone to work towards. A current project of a line (not
  // its default one) is a milestone in the making, as a `milestone` fact the person confirmed is.
  items.push({ id: "start_line", group: "主线", label: t("至少有一条主线"), done: input.lines.length > 0,
    detail: input.lines.length ? "" : t("还没有主线"), owner: "interview", start: true, ask: t("眼下你同时在推进哪几件长期的事？") });
  const milestoneNow = (input.milestones ?? 0) > 0 || input.projects.some((project) => !isDefaultProject(project.id))
    || input.facts.some((fact) => fact.slot === "milestone" && confirmedFact(fact));
  items.push({ id: "start_milestone", group: "主线", label: t("至少有一个里程碑"), done: milestoneNow,
    detail: milestoneNow ? "" : t("还没有一个要做成的阶段性结果"), owner: "interview", start: true,
    ask: t("接下来几个月，你最想做成的一件具体的事是什么？大概什么时候？") });

  for (const line of input.lines) {
    const described = input.descriptions[line.id];
    // A goal the person wrote themselves needs no candidates to choose it from.
    const candidates = (described?.candidates ?? 0) > 0 || line.goals.length > 0;
    const describedNow = Boolean(described?.description.trim())
      || input.facts.some((fact) => fact.identityId === line.id && !fact.projectId && confirmedFact(fact) && DESCRIBES_LINE.test(fact.slot) && Boolean(fact.value?.trim()));
    items.push({ id: `line_desc:${line.id}`, group: "主线", label: t("「{{line}}」有个性化描述与长期目标候选", { line: line.label }),
      done: describedNow && candidates,
      detail: !describedNow ? t("尚无描述") : !candidates ? t("尚无长期目标的候选词") : "", owner: "interview",
      ask: !describedNow ? t("「{{line}}」这条线眼下在做什么？", { line: line.label }) : t("在「{{line}}」这条线上，三五年后你希望成为什么样的人？", { line: line.label }) });
    items.push({ id: `line_goal:${line.id}`, group: "主线", label: t("「{{line}}」已选定至少一个长期目标", { line: line.label }), done: line.goals.length > 0,
      detail: line.goals.length ? "" : t("从候选中采用或自己写一个"), owner: "person" });
  }

  const projectLine = (project: string) => input.projects.find((item) => item.id === project || item.name === project)?.identityId
    ?? input.lines.find((line) => line.label === project || line.id === project)?.id;
  const hardLines = input.lines.filter((line) => line.hard);
  for (const line of hardLines) {
    // A fixed weekly arrangement of this line: from its own projects, or — said in a reply under no project — when it is the only hard line.
    const fixed = input.dates.filter((entry) => entry.recurring && (projectLine(entry.project) === line.id || (!projectLine(entry.project) && hardLines.length === 1)));
    const lineProjects = new Set(input.projects.filter((project) => project.identityId === line.id).map((project) => project.id));
    // A schedule filed under the person counts for the only hard line, as a recurring date does (2026-11-12 replay 3: her class hours were
    // `person`/`fixed_schedule_class`, the item stayed open for 32 rounds and she was asked for her timetable a second time).
    const stated = input.facts.some((fact) => (fact.identityId === line.id || lineProjects.has(fact.projectId) || (fact.identityId === "person" && hardLines.length === 1))
      && confirmedFact(fact) && statesSchedule(fact));
    // An assumed schedule does not count (dates still waiting in a batch do — the person supplied the file that has them).
    const done = fixed.length > 0 || stated;
    items.push({ id: `hard_schedule:${line.id}`, group: "日程", label: t("「{{line}}」的每周固定安排已收集", { line: line.label }), done,
      detail: done ? "" : t("每周固定要占的时间尚未收集"), owner: "interview",
      ask: t("「{{line}}」每周哪几天、几点到几点是固定占着的？比如工作日 10:00–19:30、周一上午 10:30–11:30 例会。", { line: line.label }) });
  }
  items.push({ id: "availability", group: "日程", label: t("已提出建议的可用时段"), done: input.availability,
    detail: input.availability ? "" : t("固定日程之外，每周哪些时段可以安排工作"), owner: "interview",
    ask: t("固定安排之外，每周大概哪些时段可以用来做自己的事？") });
  const pending = input.dates.filter((entry) => entry.pending).length;
  if (pending) items.push({ id: "dates_confirmed", group: "日程", label: t("文件与口述中的日期已确认"), done: false,
    detail: t("{{count}} 项日期等待确认", { count: pending }), owner: "person" });

  // Every line has something it is working on now, and when that is due — or the person said it has no deadline.
  for (const line of input.lines) {
    const current = input.projects.filter((project) => project.identityId === line.id && !isDefaultProject(project.id));
    const knowsDeadline = (project: { id: string; name: string }) =>
      input.facts.some((fact) => fact.projectId === project.id && confirmedFact(fact)
        && (/^deadline$|^date_|^no_deadline$/.test(fact.slot) || NO_DEADLINE.test(fact.value ?? "")))
      || input.dates.some((entry) => !entry.recurring && (entry.project === project.id || entry.project === project.name));
    // 「这条线先不规划」 is the person's answer to this item too: the interview offers it and the app's own line question records it.
    const skipped = input.facts.some((fact) => fact.identityId === line.id && fact.slot === "skipped" && confirmedFact(fact));
    const done = skipped || current.some(knowsDeadline);
    items.push({ id: `line_project:${line.id}`, group: "项目", label: t("「{{line}}」有当前项目，且知道截止或没有截止", { line: line.label }), done,
      detail: done ? "" : current.length
        ? t("缺截止（或说明没有截止）：{{projects}}", { projects: input.locale === "en" ? joinList(input.locale, current.map((project) => project.name)) : current.map((project) => project.name).join("、") })
        : t("尚无当前项目"),
      owner: "interview",
      ask: current.length ? t("「{{project}}」大概什么时候要完成？没有截止也可以直接说。", { project: current[0]!.name })
        : t("「{{line}}」这条线眼下在做的一件事是什么？大概什么时候要完成，没有截止也可以说。", { line: line.label }) });
  }

  // What each line has to finish this week or next (2026-11-20, §3.6; no longer a start item since 2026-11-22): one thing the person named, their 「没有」, or 「这条线先
  // 不规划」. What they name becomes a task the moment it is said (`nearTermCaptures` in the worker).
  for (const line of input.lines) {
    const lineProjects = new Set(input.projects.filter((project) => project.identityId === line.id).map((project) => project.id));
    const said = input.facts.some((fact) => (fact.identityId === line.id || lineProjects.has(fact.projectId)) && confirmedFact(fact)
      && (fact.slot === "near_term" || fact.slot === "skipped"));
    const done = said || input.nearTermSettled?.[line.id] === true;
    items.push({ id: `near_term:${line.id}`, group: "项目", label: t("「{{line}}」近两周要做完的事已说明", { line: line.label }), done,
      detail: done ? "" : t("这周到下周已经定了要做完的事（没有也可以说）"), owner: "interview",
      ask: t("「{{line}}」这周到下周有哪几件已经定了要做完的事？没有也可以直接说。", { line: line.label }) });
  }

  for (const project of input.projects.filter((item) => !isDefaultProject(item.id))) {
    const own = input.facts.filter((fact) => fact.projectId === project.id && settledFact(fact));
    const dated = input.dates.some((entry) => entry.project === project.id || entry.project === project.name);
    const course = (Boolean(courseCodeOf(project.name) ?? courseCodeOf(project.id)) && !COURSE_PART.test(project.name)) || own.some((fact) => fact.slot === "grading");
    const missing = PROJECT_SLOTS.filter(([slot, label]) => !(own.some((fact) => slot.test(fact.slot)) || (label === "截止日期" && dated))).map(([, label]) => label);
    // How a graded project is judged and when it meets: deferred, asked when its task is planned. The words are the same for a course, a
    // certification or a client's review (2026-11-22: the person is not assumed to be a student).
    const courseMissing: string[] = [];
    if (course && !own.some((fact) => fact.slot === "grading")) courseMissing.push("怎么评定");
    // A project that meets: its weekly times are the frame of the person's week (one whose meetings nobody asked about left a hole).
    const meets = input.dates.some((entry) => entry.recurring && (entry.project === project.id || entry.project === project.name))
      || own.some((fact) => MEETING_SLOTS.test(fact.slot) || (VAGUE_SCHEDULE.test(fact.value ?? "") && statesSchedule(fact)));
    if (course && !meets) courseMissing.push("固定时间");
    const projectAsk = t("「{{project}}」要做成什么样，做到哪一步了？", { project: project.name });
    items.push({ id: `project:${project.id}`, group: "项目", label: t("「{{project}}」目标、截止与进展证据", { project: project.name }),
      done: !missing.length, detail: missing.length ? t("缺：{{items}}", { items: list(missing) }) : "", owner: "interview",
      deferred: true as const, ...(missing.length ? { ask: projectAsk } : {}) });
    if (course) items.push({ id: `project_course:${project.id}`, group: "项目", label: t("「{{project}}」怎么评定与固定时间", { project: project.name }),
      done: !courseMissing.length, detail: courseMissing.length ? t("缺：{{items}}", { items: list(courseMissing) }) : "", owner: "interview",
      deferred: true as const,
      // One question asks one thing: how it is judged first, the fixed times once that is known.
      ...(courseMissing.length ? { ask: courseMissing[0] === "怎么评定" ? t("「{{project}}」最后由谁、按什么来评定？", { project: project.name })
        : t("「{{project}}」每周有哪些固定要到场的时间？", { project: project.name }) } : {}) });
  }

  if (input.unfiledFiles !== null) items.push({ id: "files_filed", group: "文件", label: t("上传的文件都已归属项目"), done: input.unfiledFiles === 0,
    detail: input.unfiledFiles ? t("{{count}} 份文件待说明归属（见待决事项）", { count: input.unfiledFiles }) : "", owner: "person" });
  return items;
}

/**
 * The deep parts of the interview a start would still be held for: none since 2026-11-22 (D10). From W-269 (2026-11-14) until then a part
 * no round had been in, or whose portrait section had nothing of the person's on record, kept the start standard from standing; now the
 * person decides when to start, and what is still thin is said when they press 「开始使用」 (the extraction's `thin` note). Kept as a
 * function so the dialogue's callers need no change.
 */
export function partsUncovered(_input: { stageOrder: readonly string[]; stagesSeen: readonly string[]; items: readonly ChecklistItem[] }): string[] {
  return [];
}

/** Whether the start items stand (D10: a line and a milestone): the person may use the app. The portrait is not required. */
export const readyToStart = (items: ChecklistItem[]) => items.filter((item) => item.start).every((item) => item.done);
/** The start items still open, in checklist order. */
export const startMissing = (items: ChecklistItem[]) => items.filter((item) => item.start && !item.done);

/** The interview's own open items, as the lines it is told and the reason a premature 「ready」 is turned back. */
export const interviewOwnedOpen = (items: ChecklistItem[]) => items.filter((item) => item.owner === "interview" && !item.done && !item.deferred);
/** Whether the interview is finished: every item that is not deferred is done. */
export const interviewComplete = (items: ChecklistItem[]) => items.every((item) => item.done || item.deferred);

/** Where the person's 「画像符合我」 is kept, with the portrait it was said about. */
export const PROFILE_CONFIRMED = "profile.confirmed";
/**
 * What a confirmation is about: the portrait's synthesis — its one line and its core conflict (2026-10-19, P3). The sections under it
 * (the problem, the compass, the energy) are rewritten as each stage ends, and confirming the synthesis covers them; including the
 * problem made every later situation edit ask again. A portrait whose synthesis is rewritten in substance is asked again.
 */
export const portraitFingerprint = (profile: Partial<ProfileModel>) =>
  [profile.portrait, profile.coreConflict].map((text) => String(text ?? "").replace(/\s+/g, "")).join("|");
/** How a confirmation was recorded before 2026-10-19 (the problem included), so a confirmation from then still holds. */
const legacyPortraitFingerprint = (profile: Partial<ProfileModel>) =>
  [profile.portrait, profile.coreConflict, profile.problem].map((text) => String(text ?? "").replace(/\s+/g, "")).join("|");

/** How alike two portraits must read (character-pair Dice) for a confirmation of one to hold for the other. */
export const PORTRAIT_SAME_SIMILARITY = 0.7;
const pairs = (text: string) => { const out = new Map<string, number>(); const chars = [...text];
  for (let index = 0; index < chars.length - 1; index += 1) { const pair = chars[index]! + chars[index + 1]!; out.set(pair, (out.get(pair) ?? 0) + 1); }
  return out; };
/**
 * Whether the person's 「符合」 still holds for the portrait as it stands. The interview rewrites the portrait every round, and an exact
 * match made every small rewording (「均被赋予」 → 「均承载」) a new portrait: the real account confirmed it and was asked again the next
 * round, every round (2026-10-15). A portrait that reads substantially the same keeps the confirmation; one rewritten in substance is
 * asked again.
 */
export function portraitStillConfirmed(confirmedFingerprint: string | undefined, profile: Partial<ProfileModel>): boolean {
  if (!confirmedFingerprint) return false;
  // Three parts: recorded before the synthesis-only fingerprint, compared as it was then.
  const current = confirmedFingerprint.split("|").length === 3 ? legacyPortraitFingerprint(profile) : portraitFingerprint(profile);
  if (current === confirmedFingerprint) return true;
  if (current.replace(/\|/g, "").length < 10) return false;
  const a = pairs(confirmedFingerprint), b = pairs(current);
  let shared = 0, total = 0;
  for (const [pair, count] of a) { shared += Math.min(count, b.get(pair) ?? 0); total += count; }
  for (const count of b.values()) total += count;
  return total > 0 && (2 * shared) / total >= PORTRAIT_SAME_SIMILARITY;
}
