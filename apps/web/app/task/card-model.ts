import type { TaskDetail } from "../../lib/task-detail";
import { tFor, type Locale } from "../../lib/i18n";
import { shortDate } from "./format";

/**
 * What the task card and the 任务 page read off a task, kept pure so it is tested apart from either: the step the person is on, the
 * picture of the steps, what the task waits for, and which of the page's four questions it answers — 现在 (do it today), 接下来 (it has
 * a time ahead), 在等 (it waits for a decision, an input, material or the gate) or 任务库 (its milestone is beyond the window).
 */
export type CardDetail = Pick<TaskDetail, "state" | "paused" | "stepPlan" | "window" | "blocker" | "materialBlocker"> & Partial<Pick<TaskDetail, "preparing">>;
type Step = NonNullable<TaskDetail["stepPlan"]>["steps"][number];
export type TaskSlotLike = { day: string; start: string; end: string };

/** The step the person is on: the first open step that is theirs (the assistant's preparation runs by itself). */
export function currentStep(detail: Pick<CardDetail, "stepPlan">): Step | undefined {
  // A provide step the system is still looking for (files, then the web) is not the person's yet.
  return detail.stepPlan?.steps.find((step) => step.status === "planned" && step.executor !== "agent" && (step as { needState?: string }).needState !== "checking");
}

/** The step whose duration is edited: the next open step that is actual work (a waiting step has no minutes). */
export function workStep(detail: Pick<CardDetail, "stepPlan">): Step | undefined {
  return detail.stepPlan?.steps.find((step) => step.status === "planned" && step.schedulable && step.executor !== "agent");
}

export type Segment = { id: string; title: string; weight: number; fill: number; kind: "done" | "current" | "waiting" | "agent" | "open" };

/** One segment per step, as wide as its share of the task, filled as far as it is done. */
export function stepSegments(detail: Pick<CardDetail, "stepPlan">): Segment[] {
  const steps = detail.stepPlan?.steps ?? [];
  const current = currentStep(detail);
  return steps.map((step) => {
    const done = step.status !== "planned";
    const kind: Segment["kind"] = done ? "done" : step.executor === "agent" ? "agent" : step === current ? (step.schedulable ? "current" : "waiting") : "open";
    return { id: step.id, title: step.title, weight: step.share > 0 ? step.share : 1, fill: done ? 1 : Math.max(0, Math.min(4, step.progressQuarter)) / 4, kind };
  });
}

/**
 * A waiting step's title without its leading 「等待」 / "Wait for", which the wait line says itself. The title is the planner model's,
 * written in either language.
 */
const awaited = (title: string) => title.replace(/^(?:等待\s*|wait(?:ing)?\s+(?:for|on)\s+)/iu, ""); // i18n-ignore

export type WaitKind = "approval" | "preparing" | "returned" | "material" | "gate" | "input" | "release";

/**
 * Why a task was sent back, in words: the ledger keeps a code (the gate's `MILESTONE_GATE_INSUFFICIENT`, an analysis blocker), which the
 * card must never show (docs/copy-style.md, no developer text); a reason already in words is shown as it is.
 */
const RETURNED: Record<string, string> = {
  MILESTONE_GATE_INSUFFICIENT: "验收证据不足", MILESTONE_GATE_PARTIAL: "交付与打法不符", MILESTONE_GATE_REFUTED: "证据与里程碑相矛盾",
  ANALYSIS_RECOVERY_REQUIRED: "分析中断，需重新分析"
};
function returnedLabel(reason: string | undefined, locale?: Locale): string {
  const t = tFor(locale);
  if (!reason) return t("已退回");
  if (!/^[A-Z][A-Z0-9_]+$/.test(reason)) return t("已退回 · {{reason}}", { reason });
  return RETURNED[reason] ? t("已退回 · {{reason}}", { reason: t(RETURNED[reason]) }) : t("已退回");
}

/** What the task waits for before the person can go on with it, in the page's words; none when it can be worked on now. */
export function waitReason(detail: CardDetail, today: string, locale?: Locale): { kind: WaitKind; label: string } | undefined {
  const t = tFor(locale);
  // A proposal whose steps are still being planned is not a decision yet: it waits for the planner, not for the person (W-31).
  if (detail.state === "awaiting_plan_approval") return detail.preparing ? { kind: "preparing", label: t("步骤规划中，规划好后再请本人批准") } : { kind: "approval", label: t("等本人批准") };
  if (detail.state === "blocked") return { kind: "returned", label: returnedLabel(detail.blocker?.reason, locale) };
  if (detail.state === "preparing") return { kind: "material", label: detail.materialBlocker ? t("材料准备已停止 · {{message}}", { message: detail.materialBlocker.message }) : t("等材料准备") };
  if (detail.state === "evidence_review") return { kind: "gate", label: t("已提交 · 等验收") };
  if (detail.state === "active") return undefined;
  const step = currentStep(detail);
  if (step && !step.schedulable) {
    const what = awaited(step.title);
    return { kind: "input", label: step.notBefore && step.notBefore > today ? t("等待 · {{what}}（{{day}} 起）", { what, day: shortDate(locale, step.notBefore) }) : t("等待 · {{what}}", { what }) };
  }
  if (detail.window.notBefore && detail.window.notBefore > today) return { kind: "release", label: t("{{day}} 起可开始", { day: shortDate(locale, detail.window.notBefore) }) };
  return undefined;
}

export type TaskGroup = "now" | "next" | "waiting" | "library" | "done" | "archived";

export function groupOf(detail: CardDetail, { today, slot, library }: { today: string; slot?: TaskSlotLike | undefined; library?: string | undefined }): TaskGroup {
  if (detail.state === "archived") return "archived";
  if (detail.state === "accepted") return "done";
  if (library) return "library";
  if (detail.state === "active") return "now";
  if (waitReason(detail, today)) return "waiting";
  if (slot?.day === today || (detail.window.dueBy && detail.window.dueBy <= today)) return "now";
  return "next";
}

/** The order inside a group: what runs first, then what comes up soonest, then the nearest deadline; the waiting by what is asked of the person first. */
const WAIT_ORDER: Record<WaitKind, number> = { returned: 0, approval: 1, input: 2, release: 3, preparing: 4, material: 4, gate: 5 };
export function compareInGroup(group: TaskGroup, today: string) {
  return (a: { detail: CardDetail; slot?: TaskSlotLike | undefined; library?: string | undefined; id: string },
    b: { detail: CardDetail; slot?: TaskSlotLike | undefined; library?: string | undefined; id: string }): number => {
    const due = (x: typeof a) => x.detail.window.dueBy ?? "9999-12-31";
    const at = (x: typeof a) => x.slot ? `${x.slot.day} ${x.slot.start}` : "9999-12-31";
    if (group === "now") {
      const running = (x: typeof a) => x.detail.state === "active" ? 0 : 1;
      return running(a) - running(b) || at(a).localeCompare(at(b)) || due(a).localeCompare(due(b)) || a.id.localeCompare(b.id);
    }
    if (group === "waiting") {
      const kind = (x: typeof a) => WAIT_ORDER[waitReason(x.detail, today)?.kind ?? "gate"];
      return kind(a) - kind(b) || due(a).localeCompare(due(b)) || a.id.localeCompare(b.id);
    }
    if (group === "library") return (a.library ?? "").localeCompare(b.library ?? "") || a.id.localeCompare(b.id);
    return at(a).localeCompare(at(b)) || due(a).localeCompare(due(b)) || a.id.localeCompare(b.id);
  };
}

/** 「还剩 5 天」「今天截止」「已过 2 天」 for a due day, given today. */
export function dueDistance(dueBy: string, today: string, locale?: Locale): { text: string; overdue: boolean } {
  const t = tFor(locale);
  const days = Math.round((Date.parse(`${dueBy.slice(0, 10)}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  if (days === 0) return { text: t("今天截止"), overdue: false };
  if (days === 1) return { text: t("明天截止"), overdue: false };
  return days > 0 ? { text: t("还剩 {{count}} 天", { count: days }), overdue: false } : { text: t("已过 {{count}} 天", { count: -days }), overdue: true };
}
