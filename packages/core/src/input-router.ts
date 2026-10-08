/**
 * What a line typed into 快速收集 is (Skill `crossline-input-router`): something new to capture, or an instruction about work that is
 * already planned (「把作业 2 推到周五」, 「复习多给一小时」). Batch text comes back as several items. A schedule item names one open task by
 * id and one change; nothing is applied here — the web previews each change across the lines (`lib/impact.ts`) and applies it on 应用,
 * or at once when the person chose that.
 */
export type ScheduleChangeType = "due" | "estimate" | "defer";
export type RoutedItem = {
  kind: "capture" | "schedule";
  /** capture: the item's own wording. */
  title: string; context: string;
  /** schedule: which open task, what changes, and one line saying it. */
  workOrderId: string; change: { type: ScheduleChangeType | "none"; date: string; minutes: number }; summary: string;
};
export type RoutedInput = { items: RoutedItem[] };

const str = { type: "string" };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const INPUT_ROUTE_SCHEMA = object({ items: { type: "array", items: object({
  kind: { type: "string", enum: ["capture", "schedule"] }, title: str, context: str, workOrderId: str,
  change: object({ type: { type: "string", enum: ["due", "estimate", "defer", "none"] }, date: str, minutes: { type: "number" } }), summary: str
}) } });

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Keeps what can be acted on: captures with a title; schedule items that name an open task and a well-formed change. Anything else is
 * dropped rather than refused — a line the router misread is better kept as a capture than lost, so a schedule item it got wrong falls
 * back to a capture of the same text.
 */
export function validateRoutedInput(value: unknown, openTaskIds: string[], originalText: string): RoutedInput {
  const answer = value as RoutedInput | undefined;
  if (!answer || !Array.isArray(answer.items)) throw new Error("INPUT_ROUTE_INVALID");
  const items: RoutedItem[] = [];
  for (const item of answer.items.slice(0, 50)) {
    if (!item || (item.kind !== "capture" && item.kind !== "schedule")) continue;
    if (item.kind === "schedule") {
      const change = item.change ?? { type: "none", date: "", minutes: 0 };
      const valid = openTaskIds.includes(item.workOrderId) && (
        ((change.type === "due" || change.type === "defer") && DAY.test(change.date))
        || (change.type === "estimate" && Number.isFinite(change.minutes) && change.minutes >= 5 && change.minutes <= 10_080));
      if (valid) { items.push({ ...item, title: "", context: "", summary: String(item.summary ?? "").slice(0, 200), change: { type: change.type, date: change.date, minutes: Math.round(change.minutes) } }); continue; }
      items.push({ kind: "capture", title: (item.summary || originalText).slice(0, 240), context: "", workOrderId: "", change: { type: "none", date: "", minutes: 0 }, summary: "" });
      continue;
    }
    const title = String(item.title ?? "").trim().slice(0, 240);
    if (title) items.push({ kind: "capture", title, context: String(item.context ?? "").trim().slice(0, 500), workOrderId: "", change: { type: "none", date: "", minutes: 0 }, summary: "" });
  }
  if (!items.length) items.push({ kind: "capture", title: originalText.trim().slice(0, 240), context: "", workOrderId: "", change: { type: "none", date: "", minutes: 0 }, summary: "" });
  return { items };
}

/** Wording that usually means an instruction about planned work rather than new work; only these lines (and batches) go to the router. */
export function looksLikeScheduleCommand(text: string): boolean {
  return /(改到|挪到|移到|推到|推迟|延后|延期|顺延|提前|往后|往前|放到|调到|改成|截止(日期)?(改|调|延)|多给|少给|加长|缩短|不做了|取消)/.test(text);
}
