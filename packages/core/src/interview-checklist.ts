import { courseCodeOf } from "./task-title";
import type { ProfileModel } from "./onboarding-turn-schema";

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
  /** What is missing, in words, when not done. */
  detail: string;
  owner: "interview" | "person";
};

export type ChecklistInput = {
  lines: Array<{ id: string; label: string; hard: boolean; goals: string[] }>;
  /** The interview's description of each line (`lines.profiles`), and how many goal candidates it proposed. */
  descriptions: Record<string, { description: string; candidates: number }>;
  profile: Partial<ProfileModel>;
  facts: Array<{ identityId: string; projectId: string; slot: string; status: string; sourceRef: string; value?: string }>;
  projects: Array<{ id: string; identityId: string; name: string }>;
  /** Dated items read from files or replies, with their project and kind, and whether they are still waiting for the person. */
  dates: Array<{ project: string; kind: string; recurring: boolean; pending: boolean; sourceRef: string }>;
  /** A weekly pattern was proposed by the interview, or the person saved their own. */
  availability: boolean;
  /** Files only the person can place; null where this is not known (the worker). */
  unfiledFiles: number | null;
  portraitConfirmed: boolean;
};

const confirmedFact = (fact: { status: string; sourceRef: string }) => fact.status === "confirmed" && /^(reply|src)-\d+$/.test(fact.sourceRef);
/**
 * An assumption the interview wrote for what the person could not say (「假设：…」, inferred; decided 2026-10-09: missing information is
 * assumed, not asked about forever). It settles an item so the interview moves on, and the item says it rests on an assumption.
 */
export const ASSUMPTION_PREFIX = /^假设[：:]/;
const assumedFact = (fact: { status: string; value?: string }) => fact.status === "inferred" && ASSUMPTION_PREFIX.test(fact.value ?? "");
const settledFact = (fact: { status: string; sourceRef: string; value?: string }) => confirmedFact(fact) || assumedFact(fact);
/** The three parts of the portrait the person's own words must stand behind, read from the slots the interview files facts under. */
const PORTRAIT_PARTS: Array<{ label: string; slots: RegExp }> = [
  { label: "现状与真问题", slots: /problem|situation|status|current|pressure|anxi|worry|constraint|gravity|stage/i },
  { label: "工作观与人生观", slots: /work_view|life_view|true_north|value|meaning|compass|purpose/i },
  { label: "能量与心流", slots: /flow|energy|drain|charge|anchor|behavio|habit/i }
];
/** The portrait's written parts, each a field of the working profile. */
const PORTRAIT_FIELDS: Array<[keyof ProfileModel, string]> = [["portrait", "一句话画像"], ["coreConflict", "核心矛盾"], ["problem", "真问题"],
  ["workView", "工作观"], ["lifeView", "人生观"], ["trueNorth", "正北"], ["says", "所说想要的"], ["does", "行为在维护的"]];
const isDefaultProject = (id: string) => /-default$/.test(id);
const PROJECT_SLOTS: Array<[RegExp, string]> = [[/^goal$|^target/, "目标"], [/^deadline$|^date_/, "截止日期"], [/^evidence$/, "进展证据"]];

export function interviewChecklist(input: ChecklistInput): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const profile = input.profile;
  const missingFields = PORTRAIT_FIELDS.filter(([key]) => !String(profile[key] ?? "").trim()).map(([, label]) => label);
  if (!String(profile.anchor ?? "").trim() && !String(profile.realWant ?? "").trim()) missingFields.push("锚与真正想要的");
  const energy = profile.energyMap ?? [];
  if (energy.length < 3 || !energy.some((item) => item.charge === "charge") || !energy.some((item) => item.charge === "drain")) missingFields.push("能量地图（至少 3 项，含充电与耗电）");
  items.push({ id: "portrait_fields", group: "画像", label: "画像各部分已写出", done: !missingFields.length, detail: missingFields.length ? `缺：${missingFields.join("、")}` : "", owner: "interview" });
  const personFacts = input.facts.filter((fact) => fact.identityId === "person" && settledFact(fact));
  const unbacked = PORTRAIT_PARTS.filter((part) => !personFacts.some((fact) => part.slots.test(fact.slot))).map((part) => part.label);
  const assumedParts = PORTRAIT_PARTS.filter((part) => !personFacts.some((fact) => confirmedFact(fact) && part.slots.test(fact.slot))).map((part) => part.label)
    .filter((label) => !unbacked.includes(label));
  items.push({ id: "portrait_grounded", group: "画像", label: "画像每部分都有本人原话或文件为据", done: !unbacked.length,
    detail: unbacked.length ? `尚无本人依据：${unbacked.join("、")}` : assumedParts.length ? `以假设代替：${assumedParts.join("、")}` : "", owner: "interview" });
  items.push({ id: "portrait_confirmed", group: "画像", label: "本人确认画像符合自己", done: input.portraitConfirmed,
    detail: input.portraitConfirmed ? "" : "在访谈页右侧画像下点「画像符合我」，或说明哪里不对", owner: "person" });

  for (const line of input.lines) {
    const described = input.descriptions[line.id];
    items.push({ id: `line_desc:${line.id}`, group: "主线", label: `「${line.label}」有个性化描述与长期目标候选`,
      done: Boolean(described?.description.trim()) && (described?.candidates ?? 0) > 0,
      detail: !described?.description.trim() ? "尚无描述" : (described.candidates ?? 0) === 0 ? "尚无长期目标候选" : "", owner: "interview" });
    items.push({ id: `line_goal:${line.id}`, group: "主线", label: `「${line.label}」已选定至少一个长期目标`, done: line.goals.length > 0,
      detail: line.goals.length ? "" : "从候选中采用或自己写一个", owner: "person" });
  }

  const projectLine = (project: string) => input.projects.find((item) => item.id === project || item.name === project)?.identityId
    ?? input.lines.find((line) => line.label === project || line.id === project)?.id;
  const hardLines = input.lines.filter((line) => line.hard);
  for (const line of hardLines) {
    // A fixed weekly arrangement of this line: from its own projects, or — said in a reply under no project — when it is the only hard line.
    const fixed = input.dates.filter((entry) => entry.recurring && (projectLine(entry.project) === line.id || (!projectLine(entry.project) && hardLines.length === 1)));
    const assumed = input.facts.some((fact) => fact.identityId === line.id && assumedFact(fact) && /schedule|meeting|class|fixed/.test(fact.slot));
    items.push({ id: `hard_schedule:${line.id}`, group: "日程", label: `硬约束「${line.label}」的固定日程已收集`, done: fixed.length > 0 || assumed,
      detail: fixed.length ? "" : assumed ? "以假设代替" : "上课、组会、值班等每周固定安排尚未收集", owner: "interview" });
  }
  items.push({ id: "availability", group: "日程", label: "已提出建议的可用时段", done: input.availability,
    detail: input.availability ? "" : "固定日程之外，每周哪些时段可以安排工作", owner: "interview" });
  const pending = input.dates.filter((entry) => entry.pending).length;
  if (pending) items.push({ id: "dates_confirmed", group: "日程", label: "文件与口述中的日期已确认", done: false, detail: `${pending} 项日期等待确认`, owner: "person" });

  for (const project of input.projects.filter((item) => !isDefaultProject(item.id))) {
    const own = input.facts.filter((fact) => fact.projectId === project.id && settledFact(fact));
    const dated = input.dates.some((entry) => entry.project === project.id || entry.project === project.name);
    const course = Boolean(courseCodeOf(project.name) ?? courseCodeOf(project.id)) || own.some((fact) => fact.slot === "grading");
    const missing = PROJECT_SLOTS.filter(([slot, label]) => !(own.some((fact) => slot.test(fact.slot)) || (label === "截止日期" && dated))).map(([, label]) => label);
    if (course && !own.some((fact) => fact.slot === "grading")) missing.push("评分占比");
    // A course meets: its weekly class times are the frame of the person's week (a course whose meetings nobody asked about left a hole).
    const meets = input.dates.some((entry) => entry.recurring && (entry.project === project.id || entry.project === project.name))
      || own.some((fact) => /^(meeting|class)_?times?$|^no_meetings$/.test(fact.slot));
    if (course && !meets) missing.push("上课时间");
    items.push({ id: `project:${project.id}`, group: "项目", label: `「${project.name}」${course ? "目标、截止、进展证据、评分占比与上课时间" : "目标、截止与进展证据"}`,
      done: !missing.length, detail: missing.length ? `缺：${missing.join("、")}` : "", owner: "interview" });
  }

  if (input.unfiledFiles !== null) items.push({ id: "files_filed", group: "文件", label: "上传的文件都已归属项目", done: input.unfiledFiles === 0,
    detail: input.unfiledFiles ? `${input.unfiledFiles} 份文件待说明归属（见待决事项）` : "", owner: "person" });
  return items;
}

/** The interview's own open items, as the lines it is told and the reason a premature 「ready」 is turned back. */
export const interviewOwnedOpen = (items: ChecklistItem[]) => items.filter((item) => item.owner === "interview" && !item.done);

/** Where the person's 「画像符合我」 is kept, with the portrait it was said about. */
export const PROFILE_CONFIRMED = "profile.confirmed";
/** What a confirmation is about: the portrait's one line, its core conflict and its problem. A portrait rewritten after is asked again. */
export const portraitFingerprint = (profile: Partial<ProfileModel>) =>
  [profile.portrait, profile.coreConflict, profile.problem].map((text) => String(text ?? "").replace(/\s+/g, "")).join("|");
