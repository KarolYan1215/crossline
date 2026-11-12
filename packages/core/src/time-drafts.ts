/**
 * 拟计时 (the owner's decisions of 2026-11-11; docs/plans/2026-11-11-walkthrough-decisions.md §1): time entries drafted from the screen
 * record the 「应用与窗口」 level already keeps, for the person to confirm. Nothing new is captured. A stretch of work is attributed in this
 * order: the person's own rules (`ActivityRule` with a target), then the work block it falls in when its category fits the step's kind,
 * then — in the worker, for what is left — a model reading the window titles (Skill `crossline-time-attributor`), and otherwise it stays
 * 「未归属的工作时间」. Only a confirmed draft becomes an execution (`inferred_confirmed`) and so measured time; an unconfirmed one never does.
 */
import { PRODUCTIVE, type ActivityCategory, type ActivityRule } from "./activity-state";

/** The drafts, written by the worker only (`apps/worker/src/time-drafts.ts`). */
export const TIME_DRAFTS = "activity.drafts";
/** What the person decided about each draft, by id, written by the web only (so the two never overwrite each other). */
export const TIME_DRAFT_DECISIONS = "activity.drafts.decided";
/** Whether the wrap-up already asked to turn on 「应用与窗口」 for drafting (`asked` / `declined`): it asks once. */
export const TIME_DRAFT_ASKED = "activity.drafts.asked";
/** A draft not confirmed within this many days is dropped. */
export const TIME_DRAFT_DAYS = 14;
const GAP_MS = 5 * 60_000;
const MIN_MINUTES = 15;

export type DraftTarget = { workOrderId?: string; stepId?: string; identityId?: string };
export type DraftBasis = "rule" | "block" | "model" | "none";
/** One drafted stretch: never a title, only the app and category that had the most of its minutes. */
export type TimeDraft = DraftTarget & { id: string; start: string; end: string; minutes: number; app: string; category: ActivityCategory;
  basis: DraftBasis; why?: string;
  /** The model has been asked about it (an unattributed draft is asked once). */
  asked?: boolean; createdAt: string };
export type DraftDecision = { decision: "confirmed" | "not_work"; at: string; workOrderId?: string };
/** A segment as the worker reads it, with its title (it never leaves the worker except to the attribution model). */
export type TitledSegment = { start: string; end: string; app: string; title: string; category: string; idle: boolean };
/** A work block that happened, in instants, with its step's kind (`STEP_ROLES`) when known. */
export type DraftBlock = { orderId: string; stepId: string; role?: string; start: string; end: string };

/** Which step kinds each work category can be (writing ↔ 撰写, a research tool ↔ 测试验证 …). */
const CATEGORY_ROLES: Partial<Record<ActivityCategory, readonly string[]>> = {
  writing: ["outline", "draft", "revise", "summarize", "record", "prepare", "review"],
  reading: ["read", "gather", "learn", "compare", "review", "prepare"],
  coding: ["build", "test", "solve", "analyze", "practice", "check"],
  research_tool: ["build", "test", "solve", "analyze", "practice", "mock", "check"]
};
/** A work category fits a step of this kind; a block whose step is not known takes any work category. */
export function categoryFitsRole(category: string, role?: string): boolean {
  if (!PRODUCTIVE.has(category as ActivityCategory)) return false;
  return !role || (CATEGORY_ROLES[category as ActivityCategory] ?? []).includes(role);
}

/** The person's first rule with a target whose words are in the app or title. */
export function ruleTarget(app: string, title: string, rules: readonly ActivityRule[]): DraftTarget | undefined {
  const haystack = `${app} ${title}`.toLowerCase();
  const rule = rules.find((item) => (item.workOrderId || item.identityId) && item.match.trim() && haystack.includes(item.match.trim().toLowerCase()));
  if (!rule) return undefined;
  return { ...(rule.workOrderId ? { workOrderId: rule.workOrderId } : {}), ...(rule.stepId ? { stepId: rule.stepId } : {}), ...(rule.identityId ? { identityId: rule.identityId } : {}) };
}

/**
 * Whether a piece of screen time is work and whose: the person's rule (which also makes its window work), else the block it lies in when
 * its category fits the block's step. Idle is never work.
 */
export function attributeSegment(segment: { app: string; title: string; category: string; idle: boolean }, rules: readonly ActivityRule[], block?: DraftBlock):
  { work: boolean; target?: DraftTarget; basis?: "rule" | "block" } {
  if (segment.idle) return { work: false };
  const ruled = ruleTarget(segment.app, segment.title, rules);
  if (ruled) return { work: true, target: ruled, basis: "rule" };
  if (!PRODUCTIVE.has(segment.category as ActivityCategory)) return { work: false };
  if (block && categoryFitsRole(segment.category, block.role)) return { work: true, target: { workOrderId: block.orderId, ...(block.stepId ? { stepId: block.stepId } : {}) }, basis: "block" };
  return { work: true };
}

type Span = { start: number; end: number };
const minus = (pieces: Span[], cut: Span): Span[] => pieces.flatMap((piece) => cut.end <= piece.start || cut.start >= piece.end ? [piece]
  : [{ start: piece.start, end: Math.min(piece.end, cut.start) }, { start: Math.max(piece.start, cut.end), end: piece.end }].filter((item) => item.end > item.start));
const targetKey = (target?: DraftTarget) => `${target?.workOrderId ?? ""}|${target?.stepId ?? ""}|${target?.identityId ?? ""}`;
const most = <T extends string>(minutes: Map<T, number>): T => [...minutes.entries()].sort((a, b) => b[1] - a[1])[0]![0];

/**
 * The drafts in a stretch of segments: work pieces (segments less the `excluded` time — timers and what was already drafted — cut at block
 * edges) attributed one by one, runs of the same attribution merged across gaps of up to five minutes, kept when at least fifteen minutes
 * and over (ended five minutes before `now`). Each comes with its titles, most time first, for the model when nothing attributed it.
 */
export function draftTimeEntries(input: { segments: TitledSegment[]; rules: readonly ActivityRule[]; blocks: DraftBlock[];
  excluded: Array<{ start: string; end: string }>; now: string }): Array<{ draft: Omit<TimeDraft, "id" | "createdAt">; titles: string[] }> {
  const excluded = input.excluded.map((item) => ({ start: Date.parse(item.start), end: Date.parse(item.end) }));
  const blocks = input.blocks.map((item) => ({ block: item, start: Date.parse(item.start), end: Date.parse(item.end) }));
  type Piece = Span & { app: string; title: string; category: string; target?: DraftTarget; basis?: "rule" | "block" };
  const pieces: Piece[] = [];
  for (const segment of input.segments) {
    if (segment.idle) continue;
    let spans = excluded.reduce((list, cut) => minus(list, cut), [{ start: Date.parse(segment.start), end: Date.parse(segment.end) }]);
    // Cut at every block edge, so each piece lies in one block or none.
    for (const edge of blocks.flatMap((item) => [item.start, item.end]))
      spans = spans.flatMap((span) => edge > span.start && edge < span.end ? [{ start: span.start, end: edge }, { start: edge, end: span.end }] : [span]);
    for (const span of spans) {
      const inside = blocks.find((item) => item.start <= span.start && span.start < item.end)?.block;
      const attributed = attributeSegment(segment, input.rules, inside);
      if (attributed.work) pieces.push({ ...span, app: segment.app, title: segment.title, category: segment.category,
        ...(attributed.target ? { target: attributed.target } : {}), ...(attributed.basis ? { basis: attributed.basis } : {}) });
    }
  }
  pieces.sort((a, b) => a.start - b.start);
  const runs: Piece[][] = [];
  for (const piece of pieces) {
    const run = runs.at(-1), last = run?.at(-1);
    if (run && last && targetKey(last.target) === targetKey(piece.target) && piece.start - last.end <= GAP_MS) run.push(piece);
    else runs.push([piece]);
  }
  const closedBy = Date.parse(input.now) - GAP_MS;
  return runs.flatMap((run) => {
    const minutes = run.reduce((sum, piece) => sum + (piece.end - piece.start) / 60_000, 0);
    const end = run.at(-1)!.end;
    if (minutes < MIN_MINUTES || end > closedBy) return [];
    const byApp = new Map<string, number>(), byCategory = new Map<string, number>(), byTitle = new Map<string, number>();
    for (const piece of run) {
      const length = piece.end - piece.start;
      byApp.set(piece.app, (byApp.get(piece.app) ?? 0) + length);
      byCategory.set(piece.category, (byCategory.get(piece.category) ?? 0) + length);
      if (piece.title.trim()) byTitle.set(piece.title.trim(), (byTitle.get(piece.title.trim()) ?? 0) + length);
    }
    const target = run[0]!.target;
    const basis: DraftBasis = run.some((piece) => piece.basis === "rule") ? "rule" : run[0]!.basis ?? "none";
    return [{ draft: { start: new Date(run[0]!.start).toISOString(), end: new Date(end).toISOString(), minutes: Math.round(minutes),
      app: most(byApp), category: most(byCategory) as ActivityCategory, ...(target ?? {}), basis },
      titles: [...byTitle.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([title]) => title.slice(0, 160)) }];
  });
}

/** The attribution model's answer (Skill `crossline-time-attributor`): per stretch, the open task and step it was for, or "" for none. */
export type TimeAttribution = { items: Array<{ id: string; workOrderId: string; stepId: string; why: string }> };
export const TIME_ATTRIBUTION_SCHEMA = { type: "object", additionalProperties: false, required: ["items"], properties: {
  items: { type: "array", maxItems: 40, items: { type: "object", additionalProperties: false, required: ["id", "workOrderId", "stepId", "why"], properties: {
    id: { type: "string", minLength: 1, maxLength: 80 }, workOrderId: { type: "string", maxLength: 120 }, stepId: { type: "string", maxLength: 80 },
    why: { type: "string", maxLength: 200 } } } } } } as const;

/**
 * The model only proposes: an answer is kept for a stretch it was asked about, once; a task that is not one of the open ones offered is
 * no task, and a step that is not that task's open step is no step.
 */
export function validateTimeAttribution(value: unknown, ids: string[], tasks: Array<{ id: string; steps: string[] }>): TimeAttribution["items"] {
  const answer = value as TimeAttribution | undefined;
  if (!answer || !Array.isArray(answer.items)) throw new Error("TIME_ATTRIBUTION_INVALID");
  const asked = new Set(ids), seen = new Set<string>(), open = new Map(tasks.map((task) => [task.id, new Set(task.steps)]));
  return answer.items.filter((item) => item && asked.has(item.id) && !seen.has(item.id) && Boolean(seen.add(item.id))).map((item) => {
    const steps = open.get(String(item.workOrderId ?? ""));
    return { id: item.id, workOrderId: steps ? item.workOrderId : "", stepId: steps?.has(String(item.stepId ?? "")) ? item.stepId : "",
      why: String(item.why ?? "").trim().slice(0, 200) };
  });
}

/**
 * The wrap-up's inference for one block (the fix of 2026-11-11): only the screen minutes that are this block's task's. A rule with a task
 * decides; else a draft the model or a rule put on a task decides; else the category has to fit the block's step. No title is needed:
 * the web reads segments without one, so a rule is matched on the app name there.
 */
export function attributedBlockSpans(input: { segments: Array<{ start: string; end: string; app: string; category: string; idle: boolean }>;
  rules: readonly ActivityRule[]; block: DraftBlock; drafts: TimeDraft[] }): Span[] {
  const from = Date.parse(input.block.start), to = Date.parse(input.block.end);
  // A draft decides when the model or a rule put it on a task, or the person did (the web passes their answer as a rule; "" is 不算工作).
  const decided = input.drafts.filter((draft) => draft.workOrderId !== undefined && (draft.basis === "model" || draft.basis === "rule"))
    .map((draft) => ({ start: Date.parse(draft.start), end: Date.parse(draft.end), orderId: draft.workOrderId! }));
  const out: Span[] = [];
  for (const segment of input.segments) {
    if (segment.idle) continue;
    const start = Math.max(from, Date.parse(segment.start)), end = Math.min(to, Date.parse(segment.end));
    if (!(end > start)) continue;
    const ruled = ruleTarget(segment.app, "", input.rules)?.workOrderId;
    if (ruled) { if (ruled === input.block.orderId) out.push({ start, end }); continue; }
    // The draft time cuts the piece: what a draft decided goes by the draft, the rest by the step's kind.
    let rest: Span[] = [{ start, end }];
    for (const draft of decided) {
      const overlap = { start: Math.max(start, draft.start), end: Math.min(end, draft.end) };
      if (!(overlap.end > overlap.start)) continue;
      if (draft.orderId === input.block.orderId) out.push(overlap);
      rest = minus(rest, overlap);
    }
    if (categoryFitsRole(segment.category, input.block.role)) out.push(...rest);
  }
  return out;
}
