/**
 * What turns a milestone from a title into a plan: a date it has to land by, where the person starts, what
 * "done" is, who else is involved, and which fact in their profile justifies it.
 *
 * A model writing "完成第一阶段" for every line is the failure this exists to refuse. Every rule below checks
 * something that can be checked in code, so a generic answer is sent back instead of reaching the person.
 */
import { isCourse } from "./profile-gaps";
export type MilestonePlan = {
  /** Local to one answer, so `dependsOn` can point at a sibling before either has a real id. */
  key: string;
  stage: number; deadline: string; baseline: string; target: string;
  stakeholders: string[]; sourceFactIds: string[]; dependsOn: string[];
  /** The result the person actually wants, which every number in this milestone is worked back from (「ECE 555 总评 A」). */
  outcome: string;
  /** The back-calculation itself, in numbers: from `outcome` to the line set here, and how much margin was left on top of it. */
  derivation: string;
  /**
   * Artifact ids (from the artifact plan) this milestone produces for another line, and the ones from other lines it uses — each used one
   * named in `derivation`. Cross-line relations are derived from these references (`deriveArtifactRelations`). Absent in answers
   * recorded before the artifact plan existed.
   */
  outputs?: string[];
  inputs?: string[];
};

/** A target the model proposes for a course from the person's long-term goals. It is stored as an unconfirmed fact, and the person can change it in one click. */
export type TargetProposal = { projectId: string; value: string; why: string };

export type ProfileForMilestones = {
  today: string;
  /** Lines the profile covers well enough that each must come back with a chain of milestones. */
  requiredIdentities: string[];
  /** Projects the person has told us enough about (several confirmed facts) that each must have a milestone of its own. */
  requiredProjects?: string[];
  /**
   * Dates read from the person's own files (a syllabus's quizzes, homework, exams, project dates), whether or not the batch has been
   * confirmed yet. A course's milestones are made from these, so a project that has several kinds of them cannot come back with one.
   */
  dates?: Array<{ project: string; kind: string; date: string; title: string }>;
  /** Graded parts a file lists but marks TBD. They have no day, but they are still part of the grade, so they still get a milestone (with a provisional deadline). */
  undated?: Array<{ project: string; kind: string; title: string }>;
  projects: Array<{ id: string; identityId: string; name: string }>;
  facts: Array<{ id: string; identityId: string; projectId: string; slot: string; value: string; status: "confirmed" | "inferred" }>;
};

/** A line needs at least this many milestones in all; one project's own chain is at most `MAX_CHAIN`; a line, whatever its projects, at most `MAX_LINE`. */
export const MIN_CHAIN = 3;
export const MAX_CHAIN = 5;
export const MAX_LINE = 12;

/** A fact is addressed by where it sits in the profile, which is also what the person sees there. */
export const profileFactId = (fact: { identityId: string; projectId: string; slot: string }) =>
  `${fact.identityId}/${fact.projectId || "-"}/${fact.slot}`;

const text = (max: number, min = 0) => ({ type: "string", minLength: min, maxLength: max }) as const;
export const MILESTONE_PLAN_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    key: text(40, 1), stage: { type: "integer", minimum: 1, maximum: MAX_CHAIN }, deadline: text(10),
    baseline: text(400), target: text(400), outcome: text(200), derivation: text(600),
    stakeholders: { type: "array", maxItems: 8, items: text(80, 1) },
    sourceFactIds: { type: "array", maxItems: 12, items: text(200, 1) },
    dependsOn: { type: "array", maxItems: 6, items: text(200, 1) },
    outputs: { type: "array", maxItems: 6, items: text(64, 1) },
    inputs: { type: "array", maxItems: 6, items: text(64, 1) }
  },
  required: ["key", "stage", "deadline", "baseline", "target", "stakeholders", "sourceFactIds", "dependsOn", "outcome", "derivation", "outputs", "inputs"]
} as const;

/**
 * A title that describes keeping something going, or a mood, is not an event that either happened by the deadline or did not.
 * 「ECE 555 课程学习保持可完成状态」 passed every other check and says nothing anyone could verify on the day.
 */
/** Things that are marked, so that finishing them is not the same as doing well in them. */
const GRADED = /考试|期末|期中|小测|测验|作业|成绩|quiz|exam|midterm|final|homework|\bHW\b/i;
const VAGUE_TITLE = /保持.*状态|可完成状态|稳定推进|[继持]续推进|维持|做好|跟上进度|不掉队/;
/**
 * The same in a target, where a number is the way out: 「保持每周 3 条发布」 is a cadence, 「保持良好」 is not. Only the person's own
 * keeping-up verbs: 「继续」 and 「持续」 were here too and refused 「获得外部试用者继续使用的证据」 — a concrete event in which
 * someone *else* continues — three times running. A guard that blocks correct work is worse than the vagueness it was written for.
 */
const VAGUE_TARGET = /保持|维持/;
const GENERIC_TITLE = /第一个可验收|当前最该推进|起步里程碑|-starter$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const day = (value: string) => Date.parse(`${value}T00:00:00Z`);

function refuse(code: string, detail: string): never {
  const error = new Error(code);
  (error as Error & { detail?: string }).detail = detail.slice(0, 400);
  throw error;
}

type ProposedMeasure = { kind?: string; unit?: string; comparator?: string; value?: number; bareLine?: number };
type Proposed = {
  identityId: string; projectId?: string; title: string; successCriteria: Array<{ evidenceOf?: string; measure?: ProposedMeasure }>; plan?: MilestonePlan;
};

/** How far past the bare line a target has to sit: a line set exactly where the outcome flips is one bad day from missing it. */
export const MARGIN_RATIO = 0.03;

/**
 * A threshold is worked backwards from the outcome, so it carries the line that would just reach it (`bareLine`), and the line it
 * actually sets sits beyond that by a margin. Returns what is wrong with it, or null. A score that cannot go past 100 is allowed to sit
 * at 100: a bare line of 99 has no room above it, and refusing that would make the only honest answer unsayable.
 */
export function thresholdProblem(measure: ProposedMeasure): string | null {
  if (measure.kind !== "threshold") return null;
  const { value, bareLine } = measure;
  if (typeof value !== "number" || typeof bareLine !== "number") return "没有给出 bareLine（刚好够到结果的最低线）";
  const safe = measure.comparator === "lte" ? bareLine - value : value - bareLine;
  const ceiling = /%|分/.test(measure.unit ?? "") && measure.comparator !== "lte" && value >= 100;
  if (safe <= 0 && !(ceiling && safe === 0 && bareLine >= 100)) return `设定的线 ${value} 没有比 bareLine ${bareLine} 更安全——它刚好卡在结果翻转的那一点上，没有留余量`;
  if (safe < Math.abs(bareLine) * MARGIN_RATIO && !ceiling) return `设定的线 ${value} 比 bareLine ${bareLine} 只多了 ${Math.round(safe * 100) / 100}，余量不到 ${MARGIN_RATIO * 100}%`;
  return null;
}
type Planned = Proposed & { plan: MilestonePlan };

/**
 * Checks a whole answer against the profile it was built from. Throws a coded error whose `detail` names the
 * milestone at fault, because a bare code gives the model nothing to repair.
 */
export function validateMilestonePlans(milestones: Proposed[], profile: ProfileForMilestones, existingIds: ReadonlySet<string>,
  proposals: TargetProposal[] = []): void {
  const known = new Set(profile.facts.map((fact) => fact.id));
  // The ids the model's own target proposals will have once they are written, so a milestone can cite one in the answer that proposes it.
  const proposedIds = new Set(proposals.map((entry) => {
    const project = profile.projects.find((candidate) => candidate.id === entry.projectId);
    return project ? profileFactId({ identityId: project.identityId, projectId: project.id, slot: "target_grade" }) : "";
  }));
  const confirmed = new Set(profile.facts.filter((fact) => fact.status === "confirmed").map((fact) => fact.id));
  const keys = new Map<string, Planned>();
  const horizon = day(profile.today) + 540 * 86_400_000;

  for (const item of milestones) {
    const label = `「${item.title}」`;
    if (!item.plan) refuse("MILESTONE_PLAN_MISSING", `${label} 没有给出阶段、截止日期和目标。`);
    const plan = item.plan;
    if (GENERIC_TITLE.test(item.title) || item.title.trim().length < 6) refuse("MILESTONE_TITLE_GENERIC", `${label} 是通用模板式的标题，要写成这个人自己的事。`);
    if (keys.has(plan.key)) refuse("MILESTONE_KEY_DUPLICATE", `key「${plan.key}」重复。`);
    // A project the profile does not have is not a project; empty means "the line as a whole".
    // Enforced only for a line that has registered projects: a line with none has nothing to name.
    if (item.projectId && profile.projects.some((project) => project.identityId === item.identityId)
      && !profile.projects.some((project) => project.id === item.projectId && project.identityId === item.identityId)) {
      refuse("MILESTONE_PROJECT_UNKNOWN", `${label} 的 projectId「${item.projectId}」不是「${item.identityId}」线里的项目。可选：${
        profile.projects.filter((project) => project.identityId === item.identityId).map((project) => project.id).join("、") || "（该线没有项目，留空）"}。`);
    }
    if (!ISO.test(plan.deadline) || Number.isNaN(day(plan.deadline))) refuse("MILESTONE_DEADLINE_REQUIRED", `${label} 需要一个 YYYY-MM-DD 截止日期，里程碑要从日期倒推。`);
    if (day(plan.deadline) < day(profile.today) || day(plan.deadline) > horizon) refuse("MILESTONE_DEADLINE_OUT_OF_RANGE", `${label} 的截止日期 ${plan.deadline} 不在今天之后的 18 个月内。`);
    if (plan.target.trim().length < 8) refuse("MILESTONE_TARGET_REQUIRED", `${label} 需要写清楚「做到什么算完成」。`);
    if (plan.baseline.trim().length < 2) refuse("MILESTONE_BASELINE_REQUIRED", `${label} 需要写出现在的起点（没开始也要写「尚未开始」）。`);
    if (VAGUE_TITLE.test(item.title) || (VAGUE_TARGET.test(plan.target) && !/\d/.test(plan.target))) {
      refuse("MILESTONE_NOT_CONCRETE", `${label} 写的是一种状态，不是一件到期那天能核对的事。改成会发生的事件：一场考试拿到什么、一份东西交出去、一个人给出了什么答复。课程就用大纲里的具体日期（小测、作业、期中、项目提交、期末）。`);
    }
    // 「完成」 is not a number. A milestone has to be checkable on its deadline, which means at least one criterion that is not a
    // judgement call, and for anything that is graded — an exam, a quiz, homework, a project mark — an actual score line. A real run
    // came back with 「ECE 555 期末考试完成并被课程方记录」: it was an event, and it had no target at all.
    const kinds = item.successCriteria.map((criterion) => criterion.measure?.kind);
    if (!kinds.some((kind) => kind === "count" || kind === "threshold" || kind === "artifact")) {
      refuse("MILESTONE_NOT_MEASURABLE", `${label} 的达成标准全是「判断」型。至少要有一条能用数字或「某个产出物存在」直接核对的标准（count / threshold / artifact）。`);
    }
    if (GRADED.test(`${item.title} ${plan.target}`) && !kinds.includes("threshold")) {
      refuse("MILESTONE_NOT_MEASURABLE", `${label} 是有分数的事（考试、小测、作业或项目），需要一条 threshold 型标准给出分数线，比如「成绩 ≥ 85 分」「平均正确率 ≥ 80%」。课程没有目标成绩时，先在 targetProposals 里提出一个，再按大纲里的评分占比从它倒推这一项的分数线（bareLine 和留了余量的 value）；其他部分的预计成绩写进 derivation 和 assumptions。`);
    }
    // Every number is worked back from the result the person wants, and says how much room was left. 「≥ 85」 with nothing behind it is a
    // guess that looks like a standard; the derivation is what the person can check, and the margin is what absorbs a bad day.
    if (plan.outcome.trim().length < 4) refuse("MILESTONE_OUTCOME_UNSTATED", `${label} 没有写 plan.outcome：这些数字是为了哪个最终结果（比如「ECE 555 总评 A」）。先有结果，再倒推数字。`);
    const thresholds = item.successCriteria.flatMap((criterion) => criterion.measure?.kind === "threshold" ? [criterion.measure] : []);
    if (thresholds.length && (plan.derivation.trim().length < 20 || !/\d/.test(plan.derivation))) {
      refuse("MILESTONE_DERIVATION_MISSING", `${label} 有分数线却没有倒推过程。plan.derivation 要写出从「${plan.outcome.trim().slice(0, 40)}」到这条线的算式：占比、其他部分预计拿多少、这一项因此至少要多少（bareLine），再说明留了多少余量。`);
    }
    for (const measure of thresholds) {
      const problem = thresholdProblem(measure);
      if (problem) refuse("MILESTONE_NO_MARGIN", `${label} 的分数线：${problem}。从结果倒推出刚好够的最低线填 bareLine，再往安全的一边多留一些（至少 ${MARGIN_RATIO * 100}%）作为 value。`);
    }
    // A course's numbers are worked back from a target grade, and that target is on the record: the person's own, or the model's proposal from
    // their long-term goals (stored as an unconfirmed fact they can change in one click). Either way the milestone has to cite it, so the
    // derivation can be traced to the number the person can edit. A course with no target at all gets one proposed in this same answer.
    const projectFacts = item.projectId ? profile.facts.filter((fact) => fact.projectId === item.projectId) : [];
    if (item.projectId && isCourse(item.projectId, projectFacts, profile.dates, profile.undated)) {
      const onRecord = projectFacts.find((fact) => fact.slot === "target_grade");
      const proposed = proposals.find((entry) => entry.projectId === item.projectId);
      if (!onRecord && !proposed) {
        refuse("MILESTONE_TARGET_UNPROPOSED", `${label} 所在的课程还没有目标成绩。根据这个人的长期目标（科研方向、职业打算、各线优先级）在 targetProposals 里先提一个：projectId「${item.projectId}」、value（如「总评 A−（≥ 90）」）、why（为什么这个目标适合他）；他之后可以一键修改，分数线会跟着重算。`);
      }
      const targetId = onRecord?.id ?? profileFactId({ identityId: item.identityId, projectId: item.projectId, slot: "target_grade" });
      if (thresholds.length && !plan.sourceFactIds.includes(targetId)) {
        refuse("MILESTONE_TARGET_NOT_CITED", `${label} 的分数线是从目标成绩倒推的，sourceFactIds 里要有目标成绩那条事实「${targetId}」，outcome 就写这个目标。`);
      }
    }
    if (!plan.sourceFactIds.length) refuse("MILESTONE_SOURCE_REQUIRED", `${label} 必须引用至少一条画像事实作为依据。`);
    for (const id of plan.sourceFactIds) {
      if (!known.has(id) && !proposedIds.has(id)) refuse("MILESTONE_SOURCE_UNKNOWN", `${label} 引用了画像里不存在的事实「${id}」。`);
    }
    // A guess the person never confirmed cannot be what a goal is built on.
    if (!plan.sourceFactIds.some((id) => confirmed.has(id))) {
      refuse("MILESTONE_SOURCE_UNCONFIRMED", `${label} 引用的事实全是推断，至少要有一条 status 为 confirmed 的事实（本人说过的或文件里写着的）。`);
    }
    // The gate reads submitted evidence, and an output is trivially easy to evidence: a milestone whose
    // criteria are all outputs passes on a productive afternoon while the goal stands still.
    if (!item.successCriteria.some((criterion) => criterion.evidenceOf === "outcome")) {
      refuse("MILESTONE_OUTCOME_REQUIRED", `${label} 的验收标准里至少要有一条 evidenceOf=outcome（世界发生了变化，而不只是产出了东西）。`);
    }
    keys.set(plan.key, { ...item, plan });
  }

  // A project whose own files give dates of several kinds — quizzes, homework, an exam, a project due date — is a chain of graded parts,
  // not one event. A real run gave ECE 555 a single milestone, the final exam, with the five quizzes, four homeworks and project dropped.
  const partOf = (kind: string) => kind === "quiz" ? "小测" : kind === "homework_out" || kind === "homework_due" ? "作业" : kind === "exam" ? "考试" : kind === "project_due" ? "项目" : "";
  for (const project of profile.projects) {
    const parts = new Map<string, number>();
    for (const entry of profile.dates ?? []) {
      const part = entry.project === project.id ? partOf(entry.kind) : "";
      if (part && entry.date >= profile.today) parts.set(part, (parts.get(part) ?? 0) + 1);
    }
    // A part the file marks TBD still counts: a project worth a quarter of the grade does not vanish because its day is not announced.
    for (const entry of profile.undated ?? []) {
      const part = entry.project === project.id ? partOf(entry.kind) : "";
      if (part) parts.set(part, (parts.get(part) ?? 0) + 1);
    }
    if (parts.size < 2) continue;
    const have = [...keys.values()].filter((item) => item.projectId === project.id).length;
    const need = Math.min(parts.size, MAX_CHAIN);
    if (have < need) {
      refuse("MILESTONE_COURSE_PARTS_MISSING", `项目「${project.name}」的文件里有 ${[...parts].map(([part, count]) => `${part} ${count} 个`).join("、")}，是一整个学期的几个有分数的部分；现在只有 ${have} 个里程碑，至少要 ${need} 个——每一类有分数的部分各一个（小测算一个，目标是平均分），按日期排成一条链，每个都带分数线。`);
    }
  }

  // Several projects can share one line, and a line with four of them and one milestone chain served one of the four: a real
  // profile (MoS2 paper, a sleep-replay study, two courses) came back with milestones for the paper alone. Every project the
  // person told us enough about needs a milestone of its own.
  for (const projectId of profile.requiredProjects ?? []) {
    const project = profile.projects.find((entry) => entry.id === projectId);
    if (project && ![...keys.values()].some((item) => item.projectId === projectId)) {
      refuse("MILESTONE_PROJECT_MISSING", `项目「${project.name}」（${projectId}，${project.identityId} 线）你说得很具体，但没有任何里程碑；每个这样的项目至少要有一个，projectId 填它的 id。`);
    }
  }

  const byIdentity = new Map<string, Planned[]>();
  for (const item of keys.values()) byIdentity.set(item.identityId, [...(byIdentity.get(item.identityId) ?? []), item]);
  // Order and dependency are a property of one project's chain, not of the whole line: two courses' deadlines say nothing about each other.
  const chainKey = (item: Planned) => `${item.identityId}/${item.projectId ?? ""}`;
  const byChain = new Map<string, Planned[]>();
  for (const item of keys.values()) byChain.set(chainKey(item), [...(byChain.get(chainKey(item)) ?? []), item]);

  for (const identityId of profile.requiredIdentities) {
    const count = byIdentity.get(identityId)?.length ?? 0;
    if (count < MIN_CHAIN) refuse("MILESTONE_CHAIN_TOO_SHORT", `主线「${identityId}」只给了 ${count} 个里程碑，需要 ${MIN_CHAIN}–${MAX_CHAIN} 个前后相接的。`);
  }
  for (const [identityId, line] of byIdentity) {
    if (line.length > MAX_LINE) refuse("MILESTONE_CHAIN_TOO_LONG", `主线「${identityId}」一共给了 ${line.length} 个里程碑，最多 ${MAX_LINE} 个。`);
  }
  for (const [name, chain] of byChain) {
    const identityId = name.split("/")[0]!;
    if (chain.length > MAX_CHAIN) refuse("MILESTONE_CHAIN_TOO_LONG", `「${name}」这条链给了 ${chain.length} 个里程碑，一个项目最多 ${MAX_CHAIN} 个。`);
    const ordered = [...chain].sort((a, b) => a.plan.stage - b.plan.stage);
    for (let i = 1; i < ordered.length; i += 1) {
      const earlier = ordered[i - 1]!, later = ordered[i]!;
      // Backward planning: a later stage cannot be due before an earlier one it builds on.
      if (later.plan.deadline < earlier.plan.deadline) {
        refuse("MILESTONE_ORDER_INCONSISTENT", `主线「${identityId}」里「${later.title}」（阶段 ${later.plan.stage}）的截止日期早于它前面的「${earlier.title}」。`);
      }
    }
  }

  for (const item of keys.values()) {
    const label = `「${item.title}」`;
    for (const dependency of item.plan.dependsOn) {
      const target = keys.get(dependency);
      if (!target && !existingIds.has(dependency)) refuse("MILESTONE_DEPENDENCY_UNKNOWN", `${label} 依赖「${dependency}」，但它不存在。`);
      if (target && target.plan.stage >= item.plan.stage) refuse("MILESTONE_DEPENDENCY_ORDER", `${label} 依赖的「${target.title}」阶段不在它之前。`);
    }
    // Chained: every stage after the first has to say what it builds on.
    if (item.plan.stage > 1 && !item.plan.dependsOn.length && (byChain.get(chainKey(item))?.length ?? 0) > 1) {
      refuse("MILESTONE_NOT_CHAINED", `${label} 是阶段 ${item.plan.stage}，必须写出它依赖前面哪个里程碑。`);
    }
  }
}
