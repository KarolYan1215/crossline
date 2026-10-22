import { infoRequestTraits, type InfoRequest } from "./info-request";

/**
 * The daily self-check that merges near-identical open tasks (the owner's decision of 2026-10-15: the real board held 「整理 ECE 548 复习
 * 材料」 next to two 「汇集 ECE 548 复习材料」, one per exam, and a standalone 「确认…」 for every exam). Rules first; only a pair the rules
 * cannot settle goes to a small model (`crossline-validation-reviewer`, `TASK_MERGE_REVIEW_SCHEMA`), and only while the quota and the
 * person's engagement allow.
 *
 * Two kinds of merge:
 * - **duplicate**: same line, same project, and the titles say the same thing once course codes, punctuation and synonymous verbs
 *   (汇集 / 汇总 / 收集 / 整理, 确认 / 核实 / 取得 …) are set aside — character-bigram Dice ≥ `TITLE_SAME` (0.6) with the intents agreeing
 *   (Dice ≥ `INTENT_UNSURE`, 0.35) or the titles near-equal (≥ `TITLE_CERTAIN`, 0.85). Different numbers in the titles (作业 2 / 作业 3)
 *   or due days more than a week apart are never the same, nor are tasks serving different milestones whose deadlines are more than 21
 *   days apart (decided 2026-10-15: a midterm's material is not the final's; not even sent to the model). Titles from `TITLE_UNSURE`
 *   (0.4) up that the rule does not settle go to the model.
 * - **info request**: a standalone request for a fact (`info-request.ts`) is folded into the task it serves — the one that names it as a
 *   dependency, else the main task of the same milestone, else of the same project — as that task's first step. Requests with nothing to
 *   serve in one milestone are merged into one (one email can ask both).
 *
 * The task kept is the one with the most progress, then the furthest state, then a step plan, then the earliest due day.
 */
export type MergeTask = {
  id: string; identityId: string; projectId: string; milestoneId: string; title: string; intent: string; state: string;
  dueDate: string; milestoneDeadline: string; progress: number; hasStepPlan: boolean; started: boolean; dependsOn: string[];
  /**
   * Who does it (docs/work-split.md): the person's work is never merged with the assistant's or with a question to the person, however
   * alike the titles — the assistant's 「汇集期中规则」 prepares the person's 「规划期中复习」, it is not the same task. Absent: the person's.
   */
  owner?: "person" | "assistant" | "ask";
};
const sideOf = (task: MergeTask) => task.owner ?? "person";
/** `requests`: for an info-request merge, what each absorbed task asks (it becomes a drafted email and a send in the kept task). */
export type MergeGroup = { kind: "duplicate" | "info_request"; keep: string; absorb: string[]; reason: string; requests: Record<string, InfoRequest> };
export type MergePair = { a: string; b: string; why: string };

export const TITLE_SAME = 0.6;
export const TITLE_UNSURE = 0.4;
/** Titles this close are the same work whatever the intents say. */
export const TITLE_CERTAIN = 0.85;
export const INTENT_UNSURE = 0.35;
const FAR_DEADLINES_DAYS = 21;
const DUE_APART_DAYS = 7;

/** States a task may be merged out of (never started); a task kept may also be under way. */
const ABSORBABLE = new Set(["awaiting_plan_approval", "approved", "preparing", "ready_for_human"]);
const KEEPABLE = new Set([...ABSORBABLE, "active"]);
const STATE_RANK: Record<string, number> = { active: 4, ready_for_human: 3, preparing: 2, approved: 1, awaiting_plan_approval: 0 };

const COURSE = /[A-Z]{2,5}\s?\d{3}/gi;
const SYNONYMS: Array<[RegExp, string]> = [
  [/汇集|汇总|收集|整合|搜集|归集/g, "整理"], [/核实|核对|取得|获取|明确|查明|弄清/g, "确认"], [/资料|素材/g, "材料"], [/目录|列表|名单/g, "清单"],
  [/考查|考核/g, "考试"], [/建立|编制|制作/g, "建立"]
];
/** A title as compared: no course code, no punctuation or spaces, no 的, synonymous verbs and nouns made one. */
export function normalizeTaskTitle(title: string): string {
  let text = title.replace(COURSE, "").replace(/[\s\p{P}\p{S}]+/gu, "").replace(/的/g, "").toLowerCase();
  for (const [pattern, word] of SYNONYMS) text = text.replace(pattern, word);
  return text;
}
const bigrams = (text: string) => { const out = new Map<string, number>(); for (let i = 0; i < text.length - 1; i++) out.set(text.slice(i, i + 2), (out.get(text.slice(i, i + 2)) ?? 0) + 1); return out; };
/** Dice similarity of two texts' character bigrams (0–1); one-character texts compare equal or not at all. */
export function textSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const x = bigrams(a), y = bigrams(b);
  let shared = 0, total = 0;
  for (const [gram, count] of x) { shared += Math.min(count, y.get(gram) ?? 0); total += count; }
  for (const count of y.values()) total += count;
  return Math.round((2 * shared / total) * 100) / 100;
}
const numbersOf = (title: string) => (title.replace(COURSE, "").match(/\d+/g) ?? []).sort().join(",");
const days = (a: string, b: string) => Math.abs(Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86_400_000;

/** What the rules say about two tasks: the same work, not, or the model's to decide. */
export function comparePair(a: MergeTask, b: MergeTask): { verdict: "same" | "unsure" | "different"; why: string; score: number } {
  if (a.identityId !== b.identityId || a.projectId !== b.projectId) return { verdict: "different", why: "不同主线或项目", score: 0 };
  if (sideOf(a) !== sideOf(b)) return { verdict: "different", why: "一个是本人的工作，一个是助手的准备或问题", score: 0 };
  if (numbersOf(a.title) !== numbersOf(b.title)) return { verdict: "different", why: "标题中的编号不同", score: 0 };
  if (a.dueDate && b.dueDate && days(a.dueDate, b.dueDate) > DUE_APART_DAYS) return { verdict: "different", why: "截止日相差一周以上", score: 0 };
  const score = textSimilarity(normalizeTaskTitle(a.title), normalizeTaskTitle(b.title));
  const intents = textSimilarity(normalizeTaskTitle(a.intent), normalizeTaskTitle(b.intent));
  if (a.milestoneId !== b.milestoneId && a.milestoneDeadline && b.milestoneDeadline && days(a.milestoneDeadline, b.milestoneDeadline) > FAR_DEADLINES_DAYS)
    return { verdict: "different", why: "服务的里程碑截止相差三周以上", score: 0 };
  // Short titles share bigrams easily (整理复习提纲 / 整理复习材料 is 0.6): a rule match needs the intents to agree too, or near-equal titles.
  const agrees = intents >= INTENT_UNSURE || score >= TITLE_CERTAIN;
  if (score >= TITLE_SAME && agrees) return { verdict: "same", why: `标题规范化后相似度 ${score}，说明相似度 ${intents}`, score };
  if (score >= TITLE_UNSURE) return { verdict: "unsure", why: `标题相似度 ${score}、说明相似度 ${intents}`, score };
  return { verdict: "different", why: `标题相似度 ${score}`, score };
}

/** The task kept from a group: most progress, furthest state, a step plan, earliest due day, then the first listed. */
export function keeperOf(tasks: MergeTask[]): MergeTask {
  return [...tasks].sort((a, b) => b.progress - a.progress || (STATE_RANK[b.state] ?? 0) - (STATE_RANK[a.state] ?? 0)
    || Number(b.hasStepPlan) - Number(a.hasStepPlan) || (a.dueDate || "9999").localeCompare(b.dueDate || "9999"))[0]!;
}

/**
 * The merges the rules decide, and the pairs left to the model. `sameByModel` are pairs the model already called the same (their ids
 * joined `a|b`, either order); they merge like rule matches. Info requests are placed first, then duplicates among what is left.
 */
export function planMerges(tasks: MergeTask[], sameByModel: ReadonlySet<string> = new Set()): { groups: MergeGroup[]; unsure: MergePair[] } {
  const live = tasks.filter((task) => KEEPABLE.has(task.state));
  const absorbable = (task: MergeTask) => ABSORBABLE.has(task.state) && !task.started;
  const taken = new Set<string>();
  const groups: MergeGroup[] = [];
  // 1. Requests for a fact go into the task they serve.
  const requests = live.filter((task) => absorbable(task)).map((task) => ({ task, traits: infoRequestTraits({ title: task.title, intent: task.intent }) }))
    .filter((item) => item.traits.match);
  const requestIds = new Set(requests.map((item) => item.task.id));
  const servers = live.filter((task) => !requestIds.has(task.id));
  const leftover: typeof requests = [];
  for (const { task, traits } of requests) {
    const sameProject = servers.filter((other) => other.identityId === task.identityId && other.projectId === task.projectId && sideOf(other) === sideOf(task));
    const served = sameProject.find((other) => other.dependsOn.includes(task.id))
      ?? (task.milestoneId ? keeperOrNone(sameProject.filter((other) => other.milestoneId === task.milestoneId)) : undefined)
      ?? (!task.milestoneId ? keeperOrNone(sameProject) : undefined);
    if (!served) { leftover.push({ task, traits }); continue; }
    const group = groups.find((item) => item.kind === "info_request" && item.keep === served.id);
    const how = traits.request!.kind === "ask_person" ? "向别人询问" : "查找一项信息";
    if (group) { group.absorb.push(task.id); group.requests[task.id] = traits.request!; group.reason += `；「${task.title}」同样并入`; }
    else groups.push({ kind: "info_request", keep: served.id, absorb: [task.id], reason: `「${task.title}」只是${how}，并入它服务的「${served.title}」作为第一步`,
      requests: { [task.id]: traits.request! } });
    taken.add(task.id);
  }
  // Requests with nothing to serve in one milestone: one email asks them all.
  const byMilestone = new Map<string, typeof requests>();
  for (const item of leftover) if (item.task.milestoneId) {
    const key = `${sideOf(item.task)}|${item.task.projectId}|${item.task.milestoneId}`;
    byMilestone.set(key, [...(byMilestone.get(key) ?? []), item]);
  }
  for (const items of byMilestone.values()) {
    if (items.length < 2) continue;
    const keep = keeperOf(items.map((item) => item.task));
    const absorb = items.filter((item) => item.task.id !== keep.id).map((item) => item.task.id);
    const asks = items.some((item) => item.traits.request!.kind === "ask_person");
    groups.push({ kind: "info_request", keep: keep.id, absorb, reason: `同一里程碑下的 ${items.length} 个获取信息任务合成${asks ? "一封邮件" : "一次查找"}`,
      requests: Object.fromEntries(items.filter((item) => item.task.id !== keep.id).map((item) => [item.task.id, item.traits.request!])) });
    for (const id of absorb) taken.add(id);
  }
  // 2. Duplicates among what is left (requests included: two identical requests are one).
  const rest = live.filter((task) => !taken.has(task.id));
  const unsure: MergePair[] = [];
  const parent = new Map(rest.map((task) => [task.id, task.id]));
  const find = (id: string): string => { const up = parent.get(id)!; return up === id ? id : find(up); };
  const why = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) {
    const a = rest[i]!, b = rest[j]!;
    // At least one side must be one that may go; two tasks under way are both kept.
    if (!absorbable(a) && !absorbable(b)) continue;
    const pair = comparePair(a, b);
    const model = sameByModel.has(`${a.id}|${b.id}`) || sameByModel.has(`${b.id}|${a.id}`);
    // The reviewer's yes merges only a pair the rules left open; what the rules call different stays apart.
    if (pair.verdict === "same" || (model && pair.verdict === "unsure")) {
      parent.set(find(b.id), find(a.id));
      why.set(find(a.id), model && pair.verdict !== "same" ? "复核判断为同一项工作" : pair.why);
    } else if (pair.verdict === "unsure") unsure.push({ a: a.id, b: b.id, why: pair.why });
  }
  const clusters = new Map<string, MergeTask[]>();
  for (const task of rest) clusters.set(find(task.id), [...(clusters.get(find(task.id)) ?? []), task]);
  for (const [root, members] of clusters) {
    if (members.length < 2) continue;
    const keep = keeperOf(members);
    const absorb = members.filter((task) => task.id !== keep.id && absorbable(task)).map((task) => task.id);
    if (absorb.length) groups.push({ kind: "duplicate", keep: keep.id, absorb, reason: `与「${keep.title}」重复（${why.get(root) ?? "标题相同"}）`, requests: {} });
  }
  const merged = new Set(groups.flatMap((group) => group.absorb));
  return { groups, unsure: unsure.filter((pair) => !merged.has(pair.a) && !merged.has(pair.b)) };
}
function keeperOrNone(tasks: MergeTask[]): MergeTask | undefined { return tasks.length ? keeperOf(tasks) : undefined; }

/**
 * Checked before a new task is kept (the owner's direction of 2026-10-15: planning should not write a task the board already has; the
 * daily merge is only the backstop). The open task `candidate` is the same work as, by the same rules the daily merge uses — the closest
 * one when several match. A pair the rules leave unsure is not stopped here: it is created and left to the daily merge and its reviewer.
 */
export function duplicateOf(candidate: MergeTask, tasks: readonly MergeTask[]): { keep: MergeTask; why: string } | undefined {
  let best: { keep: MergeTask; why: string; score: number } | undefined;
  for (const other of tasks) {
    if (other.id === candidate.id || !KEEPABLE.has(other.state)) continue;
    const pair = comparePair(candidate, other);
    if (pair.verdict === "same" && (!best || pair.score > best.score)) best = { keep: other, why: pair.why, score: pair.score };
  }
  return best && { keep: best.keep, why: best.why };
}

const str = { type: "string" };
/** The reviewer's answer for the pairs the rules left open: `same` merges them. */
export const TASK_MERGE_REVIEW_SCHEMA = { type: "object", additionalProperties: false, required: ["pairs"], properties: {
  pairs: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "same", "why"],
    properties: { id: str, same: { type: "boolean" }, why: str } } } } } as const;
export type TaskMergeReview = { pairs: Array<{ id: string; same: boolean; why: string }> };
export function validateTaskMergeReview(value: unknown, ids: readonly string[]): TaskMergeReview {
  const answer = value as TaskMergeReview | undefined;
  if (!answer || !Array.isArray(answer.pairs)) throw new Error("TASK_MERGE_REVIEW_INVALID");
  return { pairs: answer.pairs.filter((pair) => pair && ids.includes(pair.id) && typeof pair.same === "boolean")
    .map((pair) => ({ id: pair.id, same: pair.same, why: String(pair.why ?? "").trim().slice(0, 200) })) };
}

/**
 * A new item that is the same work as a task already finished (walkthrough W-30, 2026-10-17: the backplanner wrote 「整理5家试用门店
 * 清单」 a few minutes after the person had finished 「核对5家试用门店的名单与联系人」). Same rules as an open duplicate; `done` are accepted
 * tasks, which the open-task check never looked at. The closest one when several match.
 */
export function doneDuplicateOf(candidate: MergeTask, done: readonly MergeTask[]): { keep: MergeTask; why: string } | undefined {
  let best: { keep: MergeTask; why: string; score: number } | undefined;
  for (const other of done) {
    if (other.id === candidate.id || other.state !== "accepted") continue;
    const pair = comparePair(candidate, other);
    if (pair.verdict === "same" && (!best || pair.score > best.score)) best = { keep: other, why: pair.why, score: pair.score };
  }
  return best && { keep: best.keep, why: best.why };
}
