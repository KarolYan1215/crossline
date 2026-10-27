// i18n-exempt: lessons are written for the model runs that read them (step planner, assistant) and deduplicated by their text
import { SKILL_NEEDS, taskTitleOf } from "@crossline/core";
import { listAgentTasks } from "./agent";
import type { CrosslineStore, StoredLesson, StoredPreference, StoredProfileFact, UsedRef } from "./index";

/**
 * What the ledger learns from past runs, in place of Codex's own memories (docs/token-economy.md §2, the owner's decision of 2026-10-21):
 * lessons drawn by rule from what already happened — no model call, nothing per thread — given to the step planner and the assistant
 * for the line and task archetype they are about, and counted when an answer that took effect cites them.
 */

/** At most this many lessons, and this many characters in all, go into one input. */
export const LESSONS_PER_INPUT = 5;
export const LESSON_CHARACTERS_PER_INPUT = 600;
/** A step or task that took more than this many times its cautious estimate leaves a lesson. */
export const OVERRUN_RATIO = 1.5;
/** One Skill ending with the same code this many times in a week leaves a lesson. */
export const REPEATED_ERROR_RUNS = 3;
/** Ends of a run that say nothing about the work (the runtime, the quota, a cancellation): never a lesson. */
const INFRASTRUCTURE_CODE = /^(CODEX_|MODEL_|RUNTIME_|SKILL_(THREAD_LOST|TURN_FAILED|RUNTIME_\w+|LIST_FAILED|CANCELED|CANCELLED|STALLED|USAGE_LIMIT|TIMEOUT|TIMED_OUT|ABORTED|SANDBOX_UNSUPPORTED|THREAD_START_FAILED)$|RATE_LIMIT|BUDGET_)/;
/** What to do differently after a code repeats, where the code alone says it. */
const ERROR_ADVICE: Record<string, string> = {
  SKILL_SCHEMA_INVALID: "回答不符合输出结构：只返回结构要求的字段和类型",
  SKILL_REFUSED: "曾直接拒绝回答：按说明给出答案，确实做不到时写明缺什么",
  SKILL_TOOL_FORBIDDEN: "调用了没有提供的工具：只用输入里列出的工具",
  STEP_UNIT_UNVERIFIED: "内容单元的引文在文件里找不到：只逐字引用读到的原文",
  STEP_PLAN_SCHEMA_INVALID: "步骤计划结构不对：每一步都要有 id、角色和标题"
};
const RULE = { review: "rule:review_note", gate: "rule:gate_partial", overrun: "rule:estimate_overrun", error: "rule:error_repeat" } as const;
export const LESSONS_DAY_SETTING = "lessons.pass.day";

const short = (text: string, length = 30) => (text.length > length ? `${text.slice(0, length)}…` : text);
const skillShort = (skill: string) => skill.replace(/^crossline:/, "");
const bigrams = (text: string) => { const clean = text.replace(/[\s\p{P}]+/gu, ""); const out = new Set<string>(); for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2)); return out; };
/** Bigram Dice: two lessons this close say the same thing. */
export function similarText(a: string, b: string): number {
  const x = bigrams(a); const y = bigrams(b);
  if (!x.size || !y.size) return a === b ? 1 : 0;
  let shared = 0;
  for (const gram of x) if (y.has(gram)) shared += 1;
  return (2 * shared) / (x.size + y.size);
}
const SAME_LESSON = 0.8;

/**
 * Keeps a lesson unless one of the same line and archetype already says nearly the same (live or lapsed: a lapsed one went unused, a
 * reworded copy would too). Returns whether it was added.
 */
export function addLesson(store: CrosslineStore, input: Omit<StoredLesson, "id" | "useCount" | "lastUsedAt" | "invalidatedAt" | "createdAt"> & { createdAt?: string },
  existing: StoredLesson[] = store.listLessons(input.workspaceId, { includeInvalidated: true })): boolean {
  const text = input.text.trim().slice(0, 300);
  if (!text) return false;
  if (existing.some((lesson) => lesson.source === input.source && lesson.sourceRef === input.sourceRef)) return false;
  if (existing.some((lesson) => (lesson.lineId ?? "") === (input.lineId ?? "") && (lesson.archetypeId ?? "") === (input.archetypeId ?? "")
    && similarText(lesson.text, text) >= SAME_LESSON)) return false;
  const saved = store.saveLesson({ ...input, text });
  if (saved.inserted) existing.push({ ...input, text, id: saved.id, lineId: input.lineId || null, archetypeId: input.archetypeId || null,
    createdAt: input.createdAt ?? new Date().toISOString(), useCount: 0, lastUsedAt: null, invalidatedAt: null });
  return saved.inserted;
}

/** The rules (zero model calls). Returns how many lessons each added. */
export function extractLessons(store: CrosslineStore, workspaceId: string, now = new Date()): Record<"review" | "gate" | "overrun" | "error", number> {
  const existing = store.listLessons(workspaceId, { includeInvalidated: true });
  const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
  const plans = new Map(store.listStepPlans(workspaceId).map((plan) => [plan.workOrderId, plan]));
  const where = (orderId: string) => { const order = orders.get(orderId); return { lineId: order?.identityId ?? null, archetypeId: plans.get(orderId)?.archetypeId ?? null }; };
  const counts = { review: 0, gate: 0, overrun: 0, error: 0 };

  // A result of the assistant's the person sent back with words: what they said is how such work is to be done.
  const tasks = new Map(listAgentTasks(store, workspaceId, now).map((task) => [task.taskId, task]));
  for (const event of store.listEvents(workspaceId, { type: "agent.task.reviewed" })) {
    const payload = event.payload as { decision?: string; note?: string; by?: string };
    const note = String(payload.note ?? "").trim();
    if (payload.decision === "accepted" || payload.by === "system" || note.length < 4) continue;
    const task = tasks.get(event.entityId);
    if (!task) continue;
    if (addLesson(store, { workspaceId, ...where(task.workOrderId), kind: "failure", source: RULE.review, sourceRef: `review:${event.eventId}`,
      text: `助手做的「${short(task.title)}」被本人退回：${note}`, keywords: `${task.category} ${task.title}`.slice(0, 300), createdAt: event.createdAt }, existing)) counts.review += 1;
  }

  // The gate judged a hand-in 「部分符合」: it met its contract and broke the line's own play.
  for (const order of orders.values()) {
    const review = (order.payload as { gateReview?: { verdict?: string; fit?: { fits?: boolean; violated?: string[]; why?: string } } } | undefined)?.gateReview;
    if (review?.verdict !== "partial" || !review.fit || review.fit.fits) continue;
    const violated = (review.fit.violated ?? []).filter(Boolean).join("；");
    if (!violated && !review.fit.why) continue;
    const judged = store.listEvents(workspaceId, { type: "milestone_gate.judged", entityId: order.id }).at(-1);
    if (addLesson(store, { workspaceId, ...where(order.id), kind: "failure", source: RULE.gate, sourceRef: `gate:${order.id}:${judged?.eventId ?? ""}`,
      text: `「${short(taskTitleOf(order))}」验收为部分符合${violated ? `，违背：${violated}` : ""}。${review.fit.why ?? ""}`.trim(),
      keywords: `${taskTitleOf(order)} ${violated}`.slice(0, 300), ...(judged ? { createdAt: judged.createdAt } : {}) }, existing)) counts.gate += 1;
  }

  // A step confirmed at far more than its cautious estimate (the confirmed blocks' minutes summed per step), and a finished task whose
  // timed minutes did the same: the next plan of that kind is estimated looser.
  const stepMinutes = new Map<string, { orderId: string; stepId: string; minutes: number; at: string }>();
  for (const event of store.listEvents(workspaceId, { type: "block.confirmed" })) {
    const payload = event.payload as { workOrderId?: string; stepId?: string; outcome?: string; minutes?: number; blockMinutes?: number };
    if (!payload.workOrderId || !payload.stepId || payload.outcome === "not_done") continue;
    const key = `${payload.workOrderId}#${payload.stepId}`;
    const minutes = Number(payload.minutes ?? payload.blockMinutes ?? 0);
    const entry = stepMinutes.get(key) ?? { orderId: payload.workOrderId, stepId: payload.stepId, minutes: 0, at: event.createdAt };
    stepMinutes.set(key, { ...entry, minutes: entry.minutes + (Number.isFinite(minutes) ? minutes : 0), at: event.createdAt });
  }
  for (const entry of stepMinutes.values()) {
    const order = orders.get(entry.orderId);
    const step = plans.get(entry.orderId)?.steps.find((item) => item.id === entry.stepId);
    if (!order || !step || !(step.estimate.p85Minutes > 0) || entry.minutes <= step.estimate.p85Minutes * OVERRUN_RATIO) continue;
    if (addLesson(store, { workspaceId, ...where(order.id), kind: "failure", source: RULE.overrun, sourceRef: `overrun:${order.id}#${step.id}`,
      text: `「${short(taskTitleOf(order), 24)} · ${short(step.title, 24)}」实际约 ${Math.round(entry.minutes)} 分钟，保守估计 ${step.estimate.p85Minutes} 分钟：同类的${step.role}步骤估时要放宽`,
      keywords: `${step.role} ${step.title}`.slice(0, 300), createdAt: entry.at }, existing)) counts.overrun += 1;
  }
  for (const overrun of store.durationOverruns(workspaceId, OVERRUN_RATIO)) {
    const order = orders.get(overrun.workOrderId);
    if (!order) continue;
    if (addLesson(store, { workspaceId, ...where(order.id), kind: "failure", source: RULE.overrun, sourceRef: `overrun:${order.id}`,
      text: `「${short(taskTitleOf(order))}」实际 ${overrun.observedMinutes} 分钟，保守估计 ${overrun.p85Minutes} 分钟：同类任务估时要放宽`,
      keywords: taskTitleOf(order).slice(0, 300), createdAt: overrun.observedAt }, existing)) counts.overrun += 1;
  }

  // One Skill ending with the same code three times in a week: what to do differently, for that Skill's own runs only.
  const week = new Date(now.getTime() - 7 * 86_400_000).toISOString();
  const monday = (() => { const day = new Date(now); day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); return day.toISOString().slice(0, 10); })();
  for (const failed of store.failedModelRuns(workspaceId, week)) {
    if (failed.runs < REPEATED_ERROR_RUNS || INFRASTRUCTURE_CODE.test(failed.errorCode)) continue;
    const name = skillShort(failed.skill);
    const label = SKILL_NEEDS[name]?.label ?? name;
    const advice = ERROR_ADVICE[failed.errorCode] ?? (/_BLOCKED$/.test(failed.errorCode) ? "多次停下说缺东西：先用已有材料推进，缺的写明" : "");
    if (addLesson(store, { workspaceId, lineId: null, archetypeId: null, kind: "failure", source: RULE.error, sourceRef: `error:${name}:${failed.errorCode}:${monday}`,
      text: `「${label}」近 7 天 ${failed.runs} 次以 ${failed.errorCode} 结束${advice ? `：${advice}` : ""}`, keywords: `skill:${name} ${failed.errorCode}`,
      createdAt: failed.lastAt }, existing)) counts.error += 1;
  }
  return counts;
}

/**
 * Once a day per workspace (the worker tick): the rules, then what lapses unused. No model call. Returns undefined when it already ran today.
 */
export function lessonsPass(store: CrosslineStore, workspaceId: string, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  if (store.getSetting(workspaceId, LESSONS_DAY_SETTING) === day) return undefined;
  store.setSetting(workspaceId, LESSONS_DAY_SETTING, day);
  const added = extractLessons(store, workspaceId, now);
  const lapsed = store.expireUnused(workspaceId, now);
  return { added, lapsed };
}

/**
 * The lessons one input gets: of this line (or every line) and this archetype (or every one; any when the archetype is not known yet),
 * this line's and archetype's own first, then the most used and the most recent; a repeated error only to the Skill it happened in. At most
 * `LESSONS_PER_INPUT`, `LESSON_CHARACTERS_PER_INPUT` characters in all.
 */
export function lessonsFor(store: CrosslineStore, workspaceId: string, scope: { lineId: string; archetypeId?: string | undefined; skill: string | string[] }): StoredLesson[] {
  const skills = (Array.isArray(scope.skill) ? scope.skill : [scope.skill]).map((name) => `skill:${skillShort(name)}`);
  const fit = store.listLessons(workspaceId).filter((lesson) => (!lesson.lineId || lesson.lineId === scope.lineId)
    && (!lesson.archetypeId || !scope.archetypeId || lesson.archetypeId === scope.archetypeId)
    && (lesson.source !== RULE.error || lesson.keywords.split(/\s+/).some((word) => skills.includes(word))));
  const score = (lesson: StoredLesson) => (lesson.lineId === scope.lineId ? 2 : 0) + (scope.archetypeId && lesson.archetypeId === scope.archetypeId ? 1 : 0);
  const ranked = fit.sort((a, b) => score(b) - score(a) || b.useCount - a.useCount || (b.lastUsedAt ?? "").localeCompare(a.lastUsedAt ?? "")
    || b.createdAt.localeCompare(a.createdAt));
  const out: StoredLesson[] = [];
  let characters = 0;
  for (const lesson of ranked) {
    if (out.length >= LESSONS_PER_INPUT) break;
    if (characters + lesson.text.length > LESSON_CHARACTERS_PER_INPUT) continue;
    out.push(lesson);
    characters += lesson.text.length;
  }
  return out;
}

/**
 * Short ids for what an input hands a model (`f1` a fact, `p1` a preference, `l1` a lesson), so its answer can say what it rested on
 * (`usedRefs`) without copying text; `resolve` turns the cited ids back into rows, dropping any the input never gave.
 */
export function createRefBook() {
  const refs = new Map<string, UsedRef>();
  const seen = new Map<string, string>();
  const counters = { f: 0, p: 0, l: 0 };
  const name = (prefix: "f" | "p" | "l", key: string, ref: UsedRef) => {
    const known = seen.get(key);
    if (known) return known;
    counters[prefix] += 1;
    const id = `${prefix}${counters[prefix]}`;
    seen.set(key, id);
    refs.set(id, ref);
    return id;
  };
  return {
    fact: (fact: Pick<StoredProfileFact, "identityId" | "projectId" | "slot">) =>
      name("f", `f\u0000${fact.identityId}\u0000${fact.projectId}\u0000${fact.slot}`, { kind: "fact", identityId: fact.identityId, projectId: fact.projectId, slot: fact.slot }),
    pref: (entry: Pick<StoredPreference, "id">) => name("p", `p\u0000${entry.id}`, { kind: "pref", id: entry.id }),
    lesson: (lesson: Pick<StoredLesson, "id">) => name("l", `l\u0000${lesson.id}`, { kind: "lesson", id: lesson.id }),
    resolve(cited: unknown): UsedRef[] {
      if (!Array.isArray(cited)) return [];
      const ids = [...new Set(cited.filter((item): item is string => typeof item === "string").map((item) => item.trim().replace(/^\[|\]$/g, "")))];
      return ids.flatMap((id) => { const ref = refs.get(id); return ref ? [ref] : []; });
    }
  };
}
export type RefBook = ReturnType<typeof createRefBook>;
/** A line given to a model with its short id in front: 「[f3] slot：value」. */
export const withRef = (id: string, text: string) => `[${id}] ${text}`;
