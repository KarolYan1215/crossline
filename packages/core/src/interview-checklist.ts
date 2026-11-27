import { CHECKLIST_STATUSES, type ChecklistVerdict, type ProfileModel } from "./onboarding-turn-schema";
import { locateQuote } from "./sentences";
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
 *
 * What a person said is judged by the model, not by patterns over slot names and values (the owner, 2026-11-25: 「访谈清单是模型对着账本
 * 进行确认」). Each item that needs a reading of words (`byModel`) is settled by the dialogue's verdict, given every round against the ledger
 * snapshot and kept in the ledger (`readChecklistVerdicts`); code still settles what is structure — counts, recurring dates on record, the
 * person's clicks, a section written from numbered sentences — and checks that a verdict's basis is the person's own words
 * (`checkChecklistVerdicts`).
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
  /** `portrait_grounded` only: the portrait's parts (`PORTRAIT_PARTS`: `situation` … `saydo`) with nothing of the person's on record yet. */
  sections?: string[];
  /**
   * The item's `done` rests on the model's verdict against the ledger (2026-11-25, `ChecklistVerdict`): listed in every round's snapshot for
   * the model to judge, with the verdict it gave last. Items that are counts or the person's clicks are the code's and carry neither.
   */
  byModel?: true;
  verdict?: ChecklistVerdict;
  /** `portrait_grounded` only: each part as the model judges it (`portrait:<section>`), with its verdict. */
  parts?: Array<{ id: string; label: string; done: boolean; verdict?: ChecklistVerdict }>;
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
  /** The model's latest verdict per item id (`readChecklistVerdicts`), kept in the ledger by the interview's rounds. */
  verdicts?: Record<string, ChecklistVerdict> | undefined;
};

const confirmedFact = (fact: { status: string; sourceRef: string }) => fact.status === "confirmed" && /^(reply|src)-\d+$/.test(fact.sourceRef);
/**
 * The parts of the portrait the person's own words must stand behind (2026-11-25: whether a part rests on them is the model's to judge
 * against the ledger snapshot, as the checklist item `portrait:<section>`; the slot-name patterns that guessed it are gone). A part the
 * extraction wrote from numbered sentences stands without a verdict: that is structure, not a reading of words.
 */
const PORTRAIT_PARTS: Array<{ label: string; section: string; ask: string }> = [
  { label: "现状与真问题", section: "situation", ask: "眼下最让你放不下的是哪件事？" },
  { label: "工作观与人生观", section: "compass", ask: "做事的时候，你最看重的是什么？" },
  // The energy map's numbers come from here (2026-11-27, docs/plans/condense-1127.md A3): which activities charge and which drain, and
  // for each whether the person is good at it and whether they like it.
  { label: "精力：充电与耗电、擅长与喜欢", section: "energy", ask: "最近哪几件事做完更有劲，哪几件做完很累？其中哪些是你擅长的，哪些是你喜欢的？" },
  // How the person actually works (decided 2026-11-10, the owner: tasks take their form from the goal and the person's own habits, never
  // from an identity template such as 学生 → 订正/错题本/背诵/打卡; habits like these are asked in the interview). Asked in the energy part;
  // no section of the portrait stands for it, so only the model's verdict settles it.
  { label: "做事方法", section: "method", ask: "遇到要准备的考核、要赶的截止，或者要学一样新东西，你平时是怎么做的？" },
  // The two numbers no scale measures (2026-11-27, A3): each line's share of attention now, and how much each of the five say–do
  // dimensions matters to the person. No section of the portrait is written from them, so only the model's verdict settles them; a part
  // asked and still unknown is settled as such, and the report leaves its number null.
  { label: "各主线现在的注意力占比", section: "allocation", ask: "眼下你的注意力在这几条主线之间大概怎么分？比如各占几成。" },
  { label: "说与做五项各有多重要", section: "saydo", ask: "按计划投入、按时完成、收尾、等外部验收、回应别人的等待，这五样对你各有多重要？" }
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
/** Whether the model's latest verdict settles an item: answered, or not applicable with a reason. */
const settledBy = (verdict: ChecklistVerdict | undefined) => verdict?.status === "answered" || verdict?.status === "not_applicable";
/** What a partial verdict says is still missing, else the item's own words. */
const verdictDetail = (verdict: ChecklistVerdict | undefined, fallback: string) => verdict?.status === "partial" && verdict.note.trim() ? verdict.note.trim() : fallback;

export function interviewChecklist(input: ChecklistInput): ChecklistItem[] {
  const t = tFor(input.locale);
  const list = (labels: string[]) => input.locale === "en" ? joinList(input.locale, labels.map((label) => t(label))) : labels.join("、");
  const items: ChecklistItem[] = [];
  const verdicts = input.verdicts ?? {};
  /** An item whose `done` rests on the model's verdict: it carries the verdict, and the snapshot lists it for the model to judge. */
  const judged = (id: string) => ({ byModel: true as const, ...(verdicts[id] ? { verdict: verdicts[id] } : {}) });
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
  // A part rests on the person's words when the extraction wrote its section from numbered sentences (structure), or when the model judged
  // so against the ledger (`portrait:<section>`). The summary item reads the parts; only the parts are judged.
  const sectioned = new Set(input.groundedSections ?? []);
  const grounded = (section: string) => sectioned.has(section) || settledBy(verdicts[`portrait:${section}`]);
  const unbacked = PORTRAIT_PARTS.filter((part) => !grounded(part.section));
  items.push({ id: "portrait_grounded", group: "画像", label: t("画像每部分都有本人原话或文件为据"), done: !unbacked.length, sections: unbacked.map((part) => part.section),
    detail: unbacked.length ? t("尚无本人依据：{{items}}", { items: list(unbacked.map((part) => part.label)) }) : "", owner: "interview",
    ...(unbacked.length ? { ask: t(unbacked[0]!.ask) } : {}),
    parts: PORTRAIT_PARTS.map((part) => ({ id: `portrait:${part.section}`, label: t(part.label), done: grounded(part.section),
      ...(verdicts[`portrait:${part.section}`] ? { verdict: verdicts[`portrait:${part.section}`]! } : {}) })) });
  items.push({ id: "portrait_confirmed", group: "画像", label: t("本人确认画像符合自己"), done: input.portraitConfirmed,
    detail: input.portraitConfirmed ? "" : t("在画像页读完后选「符合」，或说明哪里不对"), owner: "person" });
  // The scale is a page of its own before the first round (2026-11-22) and holds nothing up: the profile_cards start item is gone.

  // The two start items (D10): scheduling needs a line to put work on and a milestone to work towards. A current project of a line (not
  // its default one) is a milestone in the making, as a `milestone` fact the person confirmed is. Both are counts, never a reading of words.
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
    const id = `line_desc:${line.id}`;
    // Written by the extraction, or judged said by the model (the slot-name pattern that read a `description` fact is gone).
    const describedNow = Boolean(described?.description.trim()) || settledBy(verdicts[id]);
    items.push({ id, group: "主线", label: t("「{{line}}」有个性化描述与长期目标候选", { line: line.label }),
      done: describedNow && candidates,
      detail: !describedNow ? verdictDetail(verdicts[id], t("尚无描述")) : !candidates ? t("尚无长期目标的候选词") : "", owner: "interview",
      ask: !describedNow ? t("「{{line}}」这条线眼下在做什么？", { line: line.label }) : t("在「{{line}}」这条线上，三五年后你希望成为什么样的人？", { line: line.label }),
      ...judged(id) });
    items.push({ id: `line_goal:${line.id}`, group: "主线", label: t("「{{line}}」已选定至少一个长期目标", { line: line.label }), done: line.goals.length > 0,
      detail: line.goals.length ? "" : t("从候选中采用或自己写一个"), owner: "person" });
  }

  const projectLine = (project: string) => input.projects.find((item) => item.id === project || item.name === project)?.identityId
    ?? input.lines.find((line) => line.label === project || line.id === project)?.id;
  const hardLines = input.lines.filter((line) => line.hard);
  for (const line of hardLines) {
    // A fixed weekly arrangement of this line on record as a recurring date (structure): from its own projects, or — said in a reply under
    // no project — when it is the only hard line. Otherwise whether the person stated it is the model's verdict (2026-11-25: the weekday,
    // clock and 「不固定」 patterns over fact values are gone).
    const fixed = input.dates.filter((entry) => entry.recurring && (projectLine(entry.project) === line.id || (!projectLine(entry.project) && hardLines.length === 1)));
    const id = `hard_schedule:${line.id}`;
    const done = fixed.length > 0 || settledBy(verdicts[id]);
    items.push({ id, group: "日程", label: t("「{{line}}」的每周固定安排已收集", { line: line.label }), done,
      detail: done ? "" : verdictDetail(verdicts[id], t("每周固定要占的时间尚未收集")), owner: "interview",
      ask: t("「{{line}}」每周哪几天、几点到几点是固定占着的？比如工作日 10:00–19:30、周一上午 10:30–11:30 例会。", { line: line.label }), ...judged(id) });
  }
  items.push({ id: "availability", group: "日程", label: t("已提出建议的可用时段"), done: input.availability,
    detail: input.availability ? "" : t("固定日程之外，每周哪些时段可以安排工作"), owner: "interview",
    ask: t("固定安排之外，每周大概哪些时段可以用来做自己的事？") });
  const pending = input.dates.filter((entry) => entry.pending).length;
  if (pending) items.push({ id: "dates_confirmed", group: "日程", label: t("文件与口述中的日期已确认"), done: false,
    detail: t("{{count}} 项日期等待确认", { count: pending }), owner: "person" });

  // Every line has something it is working on now, and when that is due — or the person said it has no deadline (the model's verdict).
  for (const line of input.lines) {
    const current = input.projects.filter((project) => project.identityId === line.id && !isDefaultProject(project.id));
    const dated = (project: { id: string; name: string }) => input.dates.some((entry) => !entry.recurring && (entry.project === project.id || entry.project === project.name));
    // 「这条线先不规划」 is the person's answer to this item too: the app's own line question records it under the slot `skipped`.
    const skipped = input.facts.some((fact) => fact.identityId === line.id && fact.slot === "skipped" && confirmedFact(fact));
    const id = `line_project:${line.id}`;
    const done = skipped || current.some(dated) || settledBy(verdicts[id]);
    items.push({ id, group: "项目", label: t("「{{line}}」有当前项目，且知道截止或没有截止", { line: line.label }), done,
      detail: done ? "" : verdictDetail(verdicts[id], current.length
        ? t("缺截止（或说明没有截止）：{{projects}}", { projects: input.locale === "en" ? joinList(input.locale, current.map((project) => project.name)) : current.map((project) => project.name).join("、") })
        : t("尚无当前项目")),
      owner: "interview",
      ask: current.length ? t("「{{project}}」大概什么时候要完成？没有截止也可以直接说。", { project: current[0]!.name })
        : t("「{{line}}」这条线眼下在做的一件事是什么？大概什么时候要完成，没有截止也可以说。", { line: line.label }), ...judged(id) });
  }

  // What each line has to finish this week or next (2026-11-20, §3.6; no longer a start item since 2026-11-22): one thing the person named, their 「没有」, or 「这条线先
  // 不规划」. What they name becomes a task the moment it is said (`nearTermCaptures` in the worker), under the slot `near_term`.
  for (const line of input.lines) {
    const lineProjects = new Set(input.projects.filter((project) => project.identityId === line.id).map((project) => project.id));
    const said = input.facts.some((fact) => (fact.identityId === line.id || lineProjects.has(fact.projectId)) && confirmedFact(fact)
      && (fact.slot === "near_term" || fact.slot === "skipped"));
    const id = `near_term:${line.id}`;
    const done = said || input.nearTermSettled?.[line.id] === true || settledBy(verdicts[id]);
    items.push({ id, group: "项目", label: t("「{{line}}」近两周要做完的事已说明", { line: line.label }), done,
      detail: done ? "" : verdictDetail(verdicts[id], t("这周到下周已经定了要做完的事（没有也可以说）")), owner: "interview",
      ask: t("「{{line}}」这周到下周有哪几件已经定了要做完的事？没有也可以直接说。", { line: line.label }), ...judged(id) });
  }

  for (const project of input.projects.filter((item) => !isDefaultProject(item.id))) {
    // A graded project is one the record calls so (its grading breakdown); a name shaped like a course code no longer makes one (IR-028,
    // 2026-11-25): whether a project is judged and meets at fixed times is the interview's to ask (its Skill).
    const course = input.facts.some((fact) => fact.projectId === project.id && fact.slot === "grading" && confirmedFact(fact));
    const id = `project:${project.id}`;
    const done = settledBy(verdicts[id]);
    items.push({ id, group: "项目", label: t("「{{project}}」目标、截止与进展证据", { project: project.name }),
      done, detail: done ? "" : verdictDetail(verdicts[id], t("目标、截止与进展证据待确认")), owner: "interview",
      deferred: true as const, ...(done ? {} : { ask: t("「{{project}}」要做成什么样，做到哪一步了？", { project: project.name }) }), ...judged(id) });
    if (!course) continue;
    // A project that meets: its weekly times on record as recurring dates (structure), or the model's verdict that they were said.
    const courseId = `project_course:${project.id}`;
    const meets = input.dates.some((entry) => entry.recurring && (entry.project === project.id || entry.project === project.name)) || settledBy(verdicts[courseId]);
    items.push({ id: courseId, group: "项目", label: t("「{{project}}」怎么评定与固定时间", { project: project.name }),
      done: meets, detail: meets ? "" : verdictDetail(verdicts[courseId], t("缺：{{items}}", { items: list(["固定时间"]) })), owner: "interview",
      deferred: true as const, ...(meets ? {} : { ask: t("「{{project}}」每周有哪些固定要到场的时间？", { project: project.name }) }), ...judged(courseId) });
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

/** One item the model judges, as the snapshot lists it: the parts of `portrait_grounded` each on their own. */
export type JudgedItem = { id: string; label: string; done: boolean; detail: string; deferred?: true; verdict?: ChecklistVerdict };
/** The items whose `done` rests on the model's verdict, in checklist order. */
export function judgedItems(items: readonly ChecklistItem[]): JudgedItem[] {
  return items.flatMap((item): JudgedItem[] => item.parts
    ? item.parts.map((part) => ({ id: part.id, label: part.label, done: part.done, detail: part.done ? "" : item.detail, ...(part.verdict ? { verdict: part.verdict } : {}) }))
    : item.byModel ? [{ id: item.id, label: item.label, done: item.done, detail: item.detail, ...(item.deferred ? { deferred: true as const } : {}),
      ...(item.verdict ? { verdict: item.verdict } : {}) }] : []);
}

/** A verdict as the ledger keeps it: the round that gave it and when. */
export type StoredVerdict = ChecklistVerdict & { round: number; at: string };
/**
 * The latest verdict per item over every interview of the workspace (each session keeps its own in `coverage.checklist`): the newest one
 * stands, so a line's own interview can settle that line's items as the main one can.
 */
export function readChecklistVerdicts(coverages: ReadonlyArray<unknown>): Record<string, ChecklistVerdict> {
  const latest = new Map<string, StoredVerdict>();
  for (const coverage of coverages) {
    const kept = (coverage as { checklist?: Record<string, StoredVerdict> } | null | undefined)?.checklist;
    if (!kept || typeof kept !== "object") continue;
    for (const [id, verdict] of Object.entries(kept)) {
      if (!verdict || !(CHECKLIST_STATUSES as readonly string[]).includes(verdict.status)) continue;
      const before = latest.get(id);
      if (!before || String(verdict.at ?? "") >= String(before.at ?? "")) latest.set(id, verdict);
    }
  }
  return Object.fromEntries([...latest].map(([id, { round: _round, at: _at, ...verdict }]) => [id, verdict]));
}

/* i18n-ignore-start: problems sent back to the interview model */
/**
 * The round's checklist verdicts, checked as evidence (the one thing about them code judges): an id the snapshot listed, a status of the
 * four, and for `answered` or `partial` at least one basis whose span is verbatim in the reply or file it names; `not_applicable` says why.
 * Whether the words settle the item is the model's; that the words exist is the code's (a claim of the model, verified).
 */
export function checkChecklistVerdicts(verdicts: readonly ChecklistVerdict[], context: { ids: ReadonlySet<string>; texts: Readonly<Record<string, string>>;
  /** Replies a disclosure sits in: never a basis, as they are never a card's. */
  sensitive?: ReadonlySet<string> }): { accepted: ChecklistVerdict[]; problems: string[] } {
  const accepted: ChecklistVerdict[] = [];
  const problems: string[] = [];
  for (const verdict of verdicts) {
    const id = String(verdict?.id ?? "");
    if (!context.ids.has(id)) { problems.push(`清单判定的 id「${id.slice(0, 60)}」不在快照的清单里；只用快照列出的 id。`); continue; }
    if (!(CHECKLIST_STATUSES as readonly string[]).includes(verdict.status)) { problems.push(`清单项「${id}」的 status 只能是 answered、partial、missing、not_applicable。`); continue; }
    const basis = Array.isArray(verdict.basis) ? verdict.basis : [];
    const note = String(verdict.note ?? "").trim();
    if (verdict.status === "not_applicable" && !note) { problems.push(`清单项「${id}」判为不适用：note 写为什么（本人说的或材料里的情况）。`); continue; }
    if ((verdict.status === "answered" || verdict.status === "partial") && !basis.length) {
      problems.push(`清单项「${id}」判为 ${verdict.status}：basis 至少引一处本人原话或文件（ref 写 reply-N 或 src-N，quote 逐字抄一段）。`); continue;
    }
    const bad = basis.find((item) => !(item.ref in context.texts) || context.sensitive?.has(item.ref) || !locateQuote(context.texts[item.ref]!, String(item.quote ?? "")));
    if (bad) {
      problems.push(context.sensitive?.has(bad.ref) ? `清单项「${id}」引了 ${bad.ref}：那条回答不作依据。`
        : !(bad.ref in context.texts) ? `清单项「${id}」的依据 ${bad.ref} 不存在；用 reply-N 或 src-N。`
        : `清单项「${id}」的依据「${String(bad.quote ?? "").slice(0, 40)}」不在 ${bad.ref} 里：逐字抄本人或文件的原话。`);
      continue;
    }
    accepted.push({ id, status: verdict.status, basis: basis.map((item) => ({ ref: item.ref, quote: String(item.quote ?? "") })), note });
  }
  return { accepted, problems };
}
/* i18n-ignore-end */
