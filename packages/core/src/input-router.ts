/**
 * What a line typed into the one input box is (Skill `crossline-input-router`): something new to capture, an instruction about work that
 * is already planned (「把作业 2 推到周五」, 「复习多给一小时」), taking back a recent operation, a long-term goal or a milestone for a line,
 * a new line, a record (how the person is doing, a note on a task), or a question for 小助手. Batch text comes back as several items.
 * Nothing is applied here: the web writes each kind through the functions the rest of the app already uses, previews schedule changes
 * (`lib/impact.ts`) and keeps every write undoable.
 */
export type ScheduleChangeType = "due" | "estimate" | "defer";
export type RoutedKind = "capture" | "schedule" | "undo" | "goal" | "milestone" | "line" | "record" | "question";
export type RoutedEnergy = "low" | "medium" | "high" | "";
export type RoutedItem = {
  kind: RoutedKind;
  /** capture: the item's wording; goal: 「成为 ___ 的 <身份>」; milestone: the achieved state; line: the identity noun; record: the note; question: the question. */
  title: string; context: string;
  /** schedule: which open task, what changes, and one line saying it. record: the task it is about, or "". */
  workOrderId: string; change: { type: ScheduleChangeType | "none"; date: string; minutes: number }; summary: string;
  /** undo: which recent operation to take back (「撤销刚才的不等了」); "" when none of them matches. */
  opId: string;
  /** goal / milestone: the line it belongs to. */
  lineId: string;
  /** milestone: its deadline (YYYY-MM-DD) or "". */
  date: string;
  /** record: the energy the person reports, or "". */
  energy: RoutedEnergy;
};
export type RoutedInput = { items: RoutedItem[] };

const str = { type: "string" };
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });
export const INPUT_ROUTE_SCHEMA = object({ items: { type: "array", items: object({
  kind: { type: "string", enum: ["capture", "schedule", "undo", "goal", "milestone", "line", "record", "question"] }, title: str, context: str, workOrderId: str,
  change: object({ type: { type: "string", enum: ["due", "estimate", "defer", "none"] }, date: str, minutes: { type: "number" } }), summary: str, opId: str,
  lineId: str, date: str, energy: { type: "string", enum: ["low", "medium", "high", ""] }
}) } });

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NONE = { workOrderId: "", change: { type: "none" as const, date: "", minutes: 0 }, summary: "", opId: "", lineId: "", date: "", energy: "" as const };

/** One capture of `title`, every other field empty: the shape anything unusable falls back to. */
export const captureItem = (title: string, context = ""): RoutedItem => ({ kind: "capture", title: title.trim().slice(0, 240), context: context.trim().slice(0, 500), ...NONE });

/**
 * Keeps what can be acted on and turns the rest back into captures of the same wording — a line the router misread is better kept as a
 * capture than lost. A goal or milestone must name a known line, a schedule change an open task, a record's task (if any) an open task.
 */
export function validateRoutedInput(value: unknown, openTaskIds: string[], originalText: string, recentOpIds: string[] = [], lineIds: string[] = []): RoutedInput {
  const answer = value as RoutedInput | undefined;
  if (!answer || !Array.isArray(answer.items)) throw new Error("INPUT_ROUTE_INVALID");
  const items: RoutedItem[] = [];
  const text = (raw: unknown, max: number) => String(raw ?? "").trim().slice(0, max);
  for (const item of answer.items.slice(0, 50)) {
    if (!item) continue;
    const title = text(item.title, 240);
    const summary = text(item.summary, 200);
    switch (item.kind) {
      // An undo names a recent operation or none; it is never turned into a capture — 「撤销刚才的…」 is not new work.
      case "undo":
        items.push({ ...NONE, kind: "undo", title: "", context: "", summary, opId: recentOpIds.includes(String(item.opId)) ? String(item.opId) : "" });
        continue;
      case "schedule": {
        const change = item.change ?? { type: "none", date: "", minutes: 0 };
        const valid = openTaskIds.includes(item.workOrderId) && (
          ((change.type === "due" || change.type === "defer") && DAY.test(change.date))
          || (change.type === "estimate" && Number.isFinite(change.minutes) && change.minutes >= 5 && change.minutes <= 10_080));
        items.push(valid ? { ...NONE, kind: "schedule", title: "", context: "", workOrderId: item.workOrderId, summary,
          change: { type: change.type, date: change.date, minutes: Math.round(change.minutes) } } : captureItem(summary || originalText));
        continue;
      }
      case "goal":
      case "milestone":
        if (title && lineIds.includes(item.lineId)) {
          items.push({ ...NONE, kind: item.kind, title: title.slice(0, item.kind === "goal" ? 60 : 200), context: text(item.context, 500), summary, lineId: item.lineId,
            date: item.kind === "milestone" && DAY.test(String(item.date)) ? String(item.date) : "" });
        } else if (title) items.push(captureItem(title, text(item.context, 500)));
        continue;
      case "line":
        if (title && title.length <= 12) items.push({ ...NONE, kind: "line", title, context: text(item.context, 500), summary });
        else if (title) items.push(captureItem(title));
        continue;
      case "record": {
        // A record lands on a task's record or as an energy reading; one that is about neither is kept as a capture.
        const workOrderId = openTaskIds.includes(item.workOrderId) ? item.workOrderId : "";
        const energy = item.energy === "low" || item.energy === "medium" || item.energy === "high" ? item.energy : "";
        if (workOrderId || energy) items.push({ ...NONE, kind: "record", title: title || summary, context: "", summary, workOrderId, energy });
        else if (title) items.push(captureItem(title));
        continue;
      }
      case "question":
        if (title) items.push({ ...NONE, kind: "question", title: text(item.title, 1000), context: "", summary });
        continue;
      case "capture":
        if (title) items.push(captureItem(title, text(item.context, 500)));
        continue;
    }
  }
  if (!items.length) items.push(captureItem(originalText));
  return { items };
}

/**
 * Wording that usually is not plain new work — an instruction about planned work, taking one back, a goal, a milestone, a new line, how
 * the person is doing, or a question. Only these lines (and batches) go to the router; anything else is captured at once.
 */
export function looksLikeScheduleCommand(text: string): boolean {
  return /(改到|挪到|移到|推到|推迟|延后|延期|顺延|提前|往后|往前|放到|调到|改成|截止(日期)?(改|调|延)|多给|少给|加长|缩短|不做了|取消|撤销|撤回|还原|恢复|点错|误点|刚才|刚刚)/.test(text)
    || /(长期目标|成为.{1,24}的|里程碑|主线|记录一下|记一下|精力|状态不好|好累|很累|太累|没精神|[?？]\s*$|^(怎么|为什么|如何|能不能|是否|哪些|什么时候))/.test(text.trim());
}
