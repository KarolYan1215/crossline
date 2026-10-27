/**
 * The one input box (design: docs/one-input.md). Everything the person types goes to one turn of Skill `crossline-concierge`, which
 * answers in words, proposes actions from the registry below as a card the person confirms, or asks one question back. Nothing the
 * model returns is written by it: the web carries out each confirmed action through the same function the rest of the app uses, and
 * every one of them is undoable for 24 hours.
 *
 * The registry is the single list of what the box can do. The model's output schema is built from it, so an action the instructions
 * mention but the schema leaves out (as `event`/`profile` once were in the input router) cannot happen again.
 */
import type { TaskOpType } from "./assistant-schema";
import { SHIFT_MINUTES } from "./schedule-frozen";
import { recordProblem } from "./records";

export type ActionRisk = "internal" | "commitment";

type Field = Record<string, unknown>;
const str = (max: number): Field => ({ type: "string", minLength: 0, maxLength: max });
const day: Field = { type: "string", minLength: 0, maxLength: 10 };
const enumOf = (values: readonly string[]): Field => ({ type: "string", enum: [...values] });
const object = (properties: Record<string, unknown>) => ({ type: "object", properties, required: Object.keys(properties), additionalProperties: false });

export const TASK_OP_TYPES: readonly TaskOpType[] = ["due", "defer", "estimate", "step_done", "step_add", "replan", "waiting", "energy", "note", "progress", "archive", "start", "tutorial"];

/**
 * What the box can do. `label` is the verb on the card; `risk` decides how the card is drawn (a commitment — approving, deciding a
 * line's drafts — is marked); `args` are the fields, every one present (unused: "", 0 or []).
 */
export const ACTIONS = {
  "task.create": { label: "新建任务", risk: "internal", args: { title: str(240), context: str(500), lineId: str(64), dueDate: day, milestoneId: str(128) } },
  "note.add": { label: "记一笔", risk: "internal", args: { text: str(1000) } },
  "task.op": { label: "修改任务", risk: "internal", args: {
    workOrderId: str(128), type: enumOf(TASK_OP_TYPES), date: day, minutes: { type: "number" }, stepId: str(40), text: str(1000), who: str(60),
    energy: enumOf(["", "low", "medium", "high"]) } },
  "ask.answer": { label: "回答待决事项", risk: "internal", args: { askId: str(200), optionId: str(64),
    fields: { type: "array", maxItems: 6, items: object({ id: str(64), value: str(500) }) } } },
  "ask.snooze": { label: "稍后再问", risk: "internal", args: { askId: str(200), until: enumOf(["tomorrow", "week"]) } },
  "undo": { label: "撤销", risk: "internal", args: { opId: str(64) } },
  "energy.report": { label: "记录精力", risk: "internal", args: { level: enumOf(["low", "medium", "high"]), note: str(300) } },
  // A record of money or health (docs/domain-lines.md): read from the person's line, a pasted text or an attached screenshot; the card
  // shows the numbers and nothing is written until the person confirms them.
  "record.add": { label: "记一笔", risk: "internal", args: { domain: enumOf(["wellness", "wealth"]),
    kind: enumOf(["income", "expense", "workout", "weight", "meal", "metric"]), value: { type: "number" }, unit: str(16), currency: str(8),
    category: str(40), note: str(200), at: day } },
  /** 「后面都推 10 分钟」: today's plan from now on starts later; what the person started or locked stays. */
  "schedule.shift": { label: "整体顺延", risk: "internal", args: { minutes: { type: "number" } } },
  "event.create": { label: "加入日程", risk: "internal", args: {
    title: str(120), date: day, weekdays: { type: "array", maxItems: 7, items: { type: "integer", minimum: 0, maximum: 6 } },
    startTime: str(5), endTime: str(5), until: day, minutes: { type: "number" }, lineId: str(64), location: str(300) } },
  /** 「明天上午提醒我取快递」: something to be told at a moment, with no work in it — said in the bell (and on the phone) then. */
  "reminder.add": { label: "设提醒", risk: "internal", args: { text: str(200), date: day, time: str(5) } },
  /**
   * An outing, a trip, an errand, an appointment the assistant can prepare for (itinerary, a list, directions, opening hours): the
   * assistant does it by itself, and a departure reminder lists the checks before leaving. The event itself is a separate `event.create`.
   */
  "errand.prepare": { label: "交给助手准备", risk: "internal", args: { title: str(120), goal: str(300), location: str(300), date: day, startTime: str(5),
    prepare: str(300), checklist: { type: "array", maxItems: 8, items: str(60) }, lineId: str(64) } },
  /** Home and work address, travel time to one place (0 = online), the default travel time, and whether a map may estimate it. */
  "travel.set": { label: "设置通勤", risk: "internal", args: { home: str(200), work: str(200), place: str(200), minutes: { type: "number" },
    defaultMinutes: { type: "number" }, useMap: enumOf(["", "on", "off"]) } },
  /**
   * 「我每天能工作 10 小时，周日休息」: the whole weekly pattern, replaced. It used to have no action, so the same line became 「交给访谈」 plus an
   * all-day Sunday event and the plan stayed on 15 hours a week (2026-10-17 walkthrough, W-15).
   */
  "availability.set": { label: "修改可用时段", risk: "internal", args: {
    // `days` is a string ("1,2,3,4,5,6"; 0 = Sunday): an array here nests past the strict-mode depth limit.
    windows: { type: "array", maxItems: 21, items: object({ days: str(20), start: str(5), end: str(5), energy: enumOf(["low", "medium", "high"]) }) } } },
  "goal.add": { label: "新增长期目标", risk: "internal", args: { lineId: str(64), title: str(60) } },
  "milestone.draft": { label: "新建里程碑草稿", risk: "internal", args: { lineId: str(64), title: str(200), date: day, target: str(500) } },
  // `domain` (docs/domain-lines.md): "" for an ordinary line, else 健康 / 财富 — at most one live line each.
  "line.add": { label: "新增主线", risk: "internal", args: { label: str(12), domain: enumOf(["", "wellness", "wealth"]) } },
  "profile.tell": { label: "交给访谈", risk: "internal", args: { text: str(2000), lineId: str(64) } },
  "workflow.request": { label: "建成自动化", risk: "internal", args: { text: str(1000), lineId: str(64), reminder: str(200), time: str(5),
    weekdays: { type: "array", maxItems: 7, items: { type: "integer", minimum: 0, maximum: 6 } } } },
  "proposal.decide": { label: "处理任务提案", risk: "commitment", args: { workOrderId: str(128), decision: enumOf(["approve", "reject"]), reason: str(300) } },
  "milestones.decide": { label: "处理里程碑草稿", risk: "commitment", args: { milestoneIds: { type: "array", maxItems: 20, items: str(128) },
    decision: enumOf(["approve", "reject"]) } },
  "agent_result.review": { label: "审阅助手成果", risk: "commitment", args: { taskId: str(128), decision: enumOf(["accepted", "rejected"]), note: str(300) } },
  "importance.set": { label: "调整重要性", risk: "internal", args: { milestoneId: str(128), weight: { type: "number" } } },
  // Files dropped into the box (P3): what each one is decides what is proposed.
  "dates.read": { label: "读取文件中的日期", risk: "internal", args: { documentId: str(64), projectId: str(128) } },
  "material.file": { label: "归入项目", risk: "internal", args: { documentId: str(64), projectId: str(128) } },
  "material.attach": { label: "作为任务材料", risk: "internal", args: { documentId: str(64), workOrderId: str(128) } },
  "evidence.submit": { label: "提交为证据", risk: "commitment", args: { workOrderId: str(128), documentIds: { type: "array", maxItems: 6, items: str(64) }, note: str(300) } },
  // Carried over from the old assistant (2026-10-10): a file it writes for a task, and a milestone template the person asked for.
  "material.save": { label: "保存为任务材料", risk: "internal", args: { workOrderId: str(128), fileName: str(80), content: str(60_000) } },
  "template.add": { label: "新增里程碑模板", risk: "internal", args: { lineId: str(64), kind: enumOf(["deliverable", "threshold", "validation", "recurring_cadence", "decision"]),
    titleHint: str(200), criteria: { type: "array", maxItems: 8, items: object({
      statement: str(300), required: { type: "boolean" }, evidenceOf: enumOf(["output", "outcome"]), measure: enumOf(["count", "threshold", "artifact", "judgement"]),
      unit: str(40), number: { type: "number" }, comparator: enumOf(["gte", "lte", ""]), mustExist: str(200), rubric: str(300), failsWhen: str(300) }) } } }
} as const satisfies Record<string, { label: string; risk: ActionRisk; args: Record<string, Field> }>;

export type ActionId = keyof typeof ACTIONS;
export const ACTION_IDS = Object.keys(ACTIONS) as ActionId[];
export const isActionId = (value: unknown): value is ActionId => typeof value === "string" && value in ACTIONS;

type ArgsOf = {
  "task.create": { title: string; context: string; lineId: string; dueDate: string; milestoneId: string };
  "note.add": { text: string };
  "task.op": { workOrderId: string; type: TaskOpType; date: string; minutes: number; stepId: string; text: string; who: string; energy: "" | "low" | "medium" | "high" };
  "ask.answer": { askId: string; optionId: string; fields: Array<{ id: string; value: string }> };
  "ask.snooze": { askId: string; until: "tomorrow" | "week" };
  "undo": { opId: string };
  "energy.report": { level: "low" | "medium" | "high"; note: string };
  "record.add": { domain: "wellness" | "wealth"; kind: "income" | "expense" | "workout" | "weight" | "meal" | "metric"; value: number; unit: string;
    currency: string; category: string; note: string; at: string };
  "event.create": { title: string; date: string; weekdays: number[]; startTime: string; endTime: string; until: string; minutes: number; lineId: string; location: string };
  "reminder.add": { text: string; date: string; time: string };
  "errand.prepare": { title: string; goal: string; location: string; date: string; startTime: string; prepare: string; checklist: string[]; lineId: string };
  "travel.set": { home: string; work: string; place: string; minutes: number; defaultMinutes: number; useMap: "" | "on" | "off" };
  "schedule.shift": { minutes: number };
  "availability.set": { windows: Array<{ days: string; start: string; end: string; energy: "low" | "medium" | "high" }> };
  "goal.add": { lineId: string; title: string };
  "milestone.draft": { lineId: string; title: string; date: string; target: string };
  "line.add": { label: string; domain: "" | "wellness" | "wealth" };
  /** `lineId`: that line's own interview (the person is on its card or page); "" = the whole interview. */
  "profile.tell": { text: string; lineId: string };
  "workflow.request": { text: string; lineId: string; reminder: string; time: string; weekdays: number[] };
  "proposal.decide": { workOrderId: string; decision: "approve" | "reject"; reason: string };
  "milestones.decide": { milestoneIds: string[]; decision: "approve" | "reject" };
  "agent_result.review": { taskId: string; decision: "accepted" | "rejected"; note: string };
  "importance.set": { milestoneId: string; weight: number };
  "dates.read": { documentId: string; projectId: string };
  "material.file": { documentId: string; projectId: string };
  "material.attach": { documentId: string; workOrderId: string };
  "evidence.submit": { workOrderId: string; documentIds: string[]; note: string };
  "material.save": { workOrderId: string; fileName: string; content: string };
  "template.add": { lineId: string; kind: "deliverable" | "threshold" | "validation" | "recurring_cadence" | "decision"; titleHint: string;
    criteria: TemplateCriterion[] };
};
/** One criterion of a proposed template, flat (one shape for every measure); `templateCriterion` turns it into a `SuccessCriterion`. */
export type TemplateCriterion = { statement: string; required: boolean; evidenceOf: "output" | "outcome"; measure: "count" | "threshold" | "artifact" | "judgement";
  unit: string; number: number; comparator: "gte" | "lte" | ""; mustExist: string; rubric: string; failsWhen: string };
export type ActionArgs<K extends ActionId> = ArgsOf[K];
export type ProposedAction = { [K in ActionId]: { action: K; summary: string; args: ArgsOf[K] } }[ActionId];

/** One option of a question back: its label, and which of the turn's candidate actions choosing it carries out ([] = say it as a reply). */
export type ClarifyOption = { label: string; actions: number[] };
export type ConciergeTurn = {
  /** What the person reads: an answer, or a line saying what the card below does. */
  reply: string;
  /** `low` sends the turn to the stronger model once (先快后准). */
  confidence: "high" | "low";
  /** Proposed actions. Those a clarify option names are candidates, carried out only if that option is chosen. */
  actions: ProposedAction[];
  /** One question back when the input could mean more than one thing; `question` "" when there is none. */
  clarify: { question: string; options: ClarifyOption[] };
  /** The message corrects the previous card (「不是作业 2，是作业 3」): that card's pending actions are withdrawn and the correction remembered. */
  corrects: boolean;
};

export const CONCIERGE_SCHEMA = object({
  reply: str(1500),
  confidence: enumOf(["high", "low"]),
  corrects: { type: "boolean" },
  actions: { type: "array", maxItems: 8, items: { anyOf: ACTION_IDS.map((id) => object({
    action: enumOf([id]), summary: str(200), args: object(ACTIONS[id].args as Record<string, unknown>) })) } },
  clarify: object({ question: str(300), options: { type: "array", maxItems: 4, items: object({ label: str(60),
    actions: { type: "array", maxItems: 8, items: { type: "integer", minimum: 0, maximum: 7 } } }) } })
});

/** What the turn may refer to, as the web knows it right now. */
export type ConciergeRefs = {
  tasks: Map<string, Set<string>>;            // open task id → its step ids
  asks: Map<string, Set<string>>;             // open ask id → its option ids
  ops: Set<string>; lines: Set<string>; milestones: Set<string>; draftMilestones: Set<string>; proposals: Set<string>; agentResults: Set<string>;
  /** `YYYY-MM-DD` in the person's zone; an event before it is refused. */
  today?: string;
  /** The person's files and projects, for the file actions. */
  documents?: Set<string>; projects?: Set<string>;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** `availability.set`'s days ("1,2,3"; 0 = Sunday): the distinct weekdays in order, or [] when any part is not one. */
export function windowDays(text: string): number[] {
  const parts = text.split(/[,，\s]+/).filter(Boolean);
  if (!parts.length || parts.some((part) => !/^[0-6]$/.test(part))) return [];
  return [...new Set(parts.map(Number))].sort((a, b) => a - b);
}

/** Why one proposed action cannot be carried out, in words the model can repair against; "" when it can. */
export function actionProblem(item: ProposedAction, refs: ConciergeRefs): string {
  const a = item.args as Record<string, unknown>;
  const task = (id: unknown) => refs.tasks.has(String(id)) ? "" : `任务 id「${String(id)}」不在打开的任务里（用 find_tasks 查 id）`;
  switch (item.action) {
    case "task.create": {
      const args = item.args;
      if (!args.title.trim()) return "新建任务缺少标题";
      if (args.dueDate && !DAY.test(args.dueDate)) return "dueDate 须为 YYYY-MM-DD 或空";
      if (args.lineId && !refs.lines.has(args.lineId)) return `主线 id「${args.lineId}」不存在`;
      if (args.milestoneId && !refs.milestones.has(args.milestoneId)) return `里程碑 id「${args.milestoneId}」不存在`;
      return "";
    }
    case "note.add": return String(a.text ?? "").trim() ? "" : "内容为空";
    case "workflow.request": return !String(a.text ?? "").trim() ? "内容为空"
      : String(a.reminder ?? "").trim() && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(a.time ?? "")) ? "提醒须有 HH:MM 的时间" : item.args.lineId && !refs.lines.has(item.args.lineId) ? `主线 id「${item.args.lineId}」不存在`
      // A workflow is written in one line's way and used on that line only; with none named it used to land on the first line.
      : !String(a.reminder ?? "").trim() && !item.args.lineId ? "自动化须写明服务哪条主线（lineId）；看不出是哪条时用 clarify 列出主线让本人选" : "";
    case "profile.tell": return !String(a.text ?? "").trim() ? "内容为空" : item.args.lineId && !refs.lines.has(item.args.lineId) ? `主线 id「${item.args.lineId}」不存在` : "";
    case "task.op": {
      const args = item.args;
      const missing = task(args.workOrderId);
      if (missing) return missing;
      const steps = refs.tasks.get(args.workOrderId)!;
      switch (args.type) {
        case "due": case "defer": return DAY.test(args.date) ? "" : "日期须为 YYYY-MM-DD";
        case "estimate": return Number.isFinite(args.minutes) && args.minutes >= 5 && args.minutes <= 480 && (!args.stepId || steps.has(args.stepId)) ? "" : "时长须在 5–480 分钟，stepId 须是该任务的步骤";
        case "step_done": return steps.has(args.stepId) ? "" : "stepId 须是该任务的步骤（用 get_task 查）";
        case "step_add": case "replan": case "note": case "progress": return args.text.trim() ? "" : "text 为空";
        case "waiting": return args.text.trim() && DAY.test(args.date) ? "" : "等待项需要 text 与日期";
        case "energy": return args.energy ? "" : "energy 须为 low/medium/high";
        default: return "";
      }
    }
    case "ask.answer": {
      const options = refs.asks.get(item.args.askId);
      if (!options) return `待决事项 id「${item.args.askId}」不存在（用 list_asks 查）`;
      return options.has(item.args.optionId) ? "" : `选项「${item.args.optionId}」不是该待决事项的选项（可选：${[...options].join("、")}）`;
    }
    case "ask.snooze": return refs.asks.has(item.args.askId) ? "" : `待决事项 id「${item.args.askId}」不存在`;
    case "undo": return refs.ops.has(item.args.opId) ? "" : `操作 id「${item.args.opId}」不在最近 24 小时的可撤销操作里`;
    case "energy.report": return "";
    // The same checks the store applies; an empty day is today.
    case "record.add": return recordProblem({ ...item.args, at: item.args.at || new Date().toISOString().slice(0, 10) });
    case "schedule.shift": return Number.isInteger(item.args.minutes) && item.args.minutes >= SHIFT_MINUTES.min && item.args.minutes <= SHIFT_MINUTES.max
      ? "" : `顺延分钟数须为 ${SHIFT_MINUTES.min}–${SHIFT_MINUTES.max} 的整数`;
    case "event.create": {
      const args = item.args;
      if (!args.title.trim()) return "日程缺少标题";
      const timed = TIME.test(args.startTime) && TIME.test(args.endTime) && args.endTime > args.startTime;
      if ((args.startTime || args.endTime) && !timed) return "起止时间须为 HH:MM 且结束晚于开始";
      if (args.weekdays.length) return timed && DAY.test(args.until) ? "" : "周期日程需要起止时间和 until 日期";
      if (!DAY.test(args.date)) return "一次性日程需要 date";
      return refs.today && args.date < refs.today ? `日期 ${args.date} 已过去（今天 ${refs.today}）；本周已过的星期几指下一个` : "";
    }
    case "reminder.add": {
      const args = item.args;
      if (!args.text.trim()) return "提醒内容为空";
      if (args.date && !DAY.test(args.date)) return "date 须为 YYYY-MM-DD 或空（今天）";
      if (args.time && !TIME.test(args.time)) return "time 须为 HH:MM 或空（上午 9 点）";
      return refs.today && args.date && args.date < refs.today ? `日期 ${args.date} 已过去（今天 ${refs.today}）` : "";
    }
    case "errand.prepare": {
      const args = item.args;
      if (!args.title.trim()) return "缺少事项名称";
      if (args.date && !DAY.test(args.date)) return "date 须为 YYYY-MM-DD 或空（今天）";
      if (args.startTime && !TIME.test(args.startTime)) return "startTime 须为 HH:MM 或空";
      if (args.lineId && !refs.lines.has(args.lineId)) return `主线 id「${args.lineId}」不存在（生活事务 lineId 留空）`;
      return refs.today && args.date && args.date < refs.today ? `日期 ${args.date} 已过去（今天 ${refs.today}）` : "";
    }
    case "travel.set": {
      const args = item.args;
      const minutesOk = (value: number) => Number.isFinite(value) && value >= 0 && value <= 240;
      if (!args.home.trim() && !args.work.trim() && !args.place.trim() && !args.defaultMinutes && !args.useMap) return "没有要设置的内容";
      if (args.place.trim() && !minutesOk(args.minutes)) return "某地的通勤分钟须为 0–240（0 表示线上）";
      return minutesOk(args.defaultMinutes) ? "" : "默认通勤分钟须为 0–240";
    }
    case "availability.set": {
      const windows = item.args.windows;
      if (!windows.length) return "需要至少一个时段（完整的新每周时段，不是改动的部分）";
      const bad = windows.find((window) => !windowDays(window.days).length || !TIME.test(window.start) || !TIME.test(window.end) || window.end <= window.start);
      return bad ? "每个时段需要 days（逗号分隔的 0–6，0 = 周日）和 HH:MM 起止时间，且结束晚于开始（跨午夜拆成两段）" : "";
    }
    case "goal.add": case "milestone.draft":
      if (!refs.lines.has(item.args.lineId)) return `主线 id「${item.args.lineId}」不存在`;
      if (!item.args.title.trim()) return "标题为空";
      return item.action === "milestone.draft" && item.args.date && !DAY.test(item.args.date) ? "date 须为 YYYY-MM-DD 或空" : "";
    case "line.add": return item.args.label.trim() || item.args.domain ? "" : "主线名为空";
    case "proposal.decide": return refs.proposals.has(item.args.workOrderId) ? "" : `「${item.args.workOrderId}」不是待批准的任务提案`;
    case "milestones.decide": {
      const unknown = item.args.milestoneIds.filter((id) => !refs.draftMilestones.has(id));
      return !item.args.milestoneIds.length ? "未指定里程碑草稿" : unknown.length ? `这些不是里程碑草稿：${unknown.join("、")}` : "";
    }
    case "agent_result.review": return refs.agentResults.has(item.args.taskId) ? "" : `「${item.args.taskId}」不是待审阅的助手成果`;
    case "importance.set": return refs.milestones.has(item.args.milestoneId) && item.args.weight >= 0 && item.args.weight <= 100 ? "" : "里程碑不存在或重要性不在 0–100";
    case "dates.read": case "material.file": {
      const doc = refs.documents?.has(item.args.documentId) ? "" : `文件 id「${item.args.documentId}」不存在（用 find_materials 查）`;
      if (doc) return doc;
      if (!item.args.projectId) return item.action === "material.file" ? "归入项目需要 projectId" : "";
      return refs.projects?.has(item.args.projectId) ? "" : `项目 id「${item.args.projectId}」不存在（见概况里的项目列表）`;
    }
    case "material.attach":
      return !refs.documents?.has(item.args.documentId) ? `文件 id「${item.args.documentId}」不存在` : task(item.args.workOrderId);
    case "evidence.submit": {
      const missing = item.args.documentIds.filter((id) => !refs.documents?.has(id));
      return !item.args.documentIds.length ? "没有指定文件" : missing.length ? `这些文件 id 不存在：${missing.join("、")}` : task(item.args.workOrderId);
    }
    case "material.save": {
      if (!/^[\w\u4e00-\u9fff][\w\u4e00-\u9fff .-]{0,78}\.(md|txt|csv|json|py|ts|js|m|r|sh|ps1|tex|html|css|ipynb)$/.test(item.args.fileName) || item.args.fileName.includes(".."))
        return "fileName 须是不含路径的文件名，扩展名为 md/txt/csv/json/py/ts/js/m/r/sh/ps1/tex/html/css/ipynb";
      return item.args.content.trim() ? task(item.args.workOrderId) : "内容为空";
    }
    case "template.add":
      if (!refs.lines.has(item.args.lineId)) return `主线 id「${item.args.lineId}」不存在`;
      if (!item.args.titleHint.trim() || !item.args.criteria.length) return "模板需要标题与至少一条标准";
      return item.args.criteria.every((criterion) => criterion.statement.trim()) ? "" : "每条标准都需要表述";
  }
}

/**
 * The turn as it can be shown: every action carried out as proposed or not at all. An action that refers to something that does not
 * exist is a rejection the model repairs (it can look the id up); after the repairs, `keepUsable` keeps the rest.
 */
export function validateConciergeTurn(raw: unknown, refs: ConciergeRefs): ConciergeTurn {
  const turn = normalizeTurn(raw);
  const problems = turn.actions.map((item, index) => ({ index, problem: actionProblem(item, refs) })).filter((entry) => entry.problem);
  if (problems.length) throw Object.assign(new Error("CONCIERGE_ACTION_INVALID"), {
    detail: problems.map((entry) => `actions[${entry.index}]（${entry.problem}）`).join("；") });
  if (!turn.reply.trim() && !turn.actions.length && !turn.clarify.question) throw new Error("CONCIERGE_EMPTY");
  return turn;
}

/** After the repairs: drops the actions that still cannot be carried out, and clarify options left with nothing to do. */
export function keepUsable(raw: unknown, refs: ConciergeRefs): ConciergeTurn | undefined {
  let turn: ConciergeTurn;
  try { turn = normalizeTurn(raw); } catch { return undefined; }
  const keep = turn.actions.map((item) => !actionProblem(item, refs));
  const renumber = new Map<number, number>();
  turn.actions.forEach((_, index) => { if (keep[index]) renumber.set(index, renumber.size); });
  const actions = turn.actions.filter((_, index) => keep[index]);
  const options = turn.clarify.options.map((option) => ({ label: option.label, actions: option.actions.filter((index) => renumber.has(index)).map((index) => renumber.get(index)!) }))
    .filter((option, index) => option.actions.length || !turn.clarify.options[index]!.actions.length);
  const dropped = turn.actions.length - actions.length;
  const reply = [turn.reply, dropped ? `有 ${dropped} 项无法确定对象，未列出。` : ""].filter(Boolean).join(" ");
  if (!reply && !actions.length && !options.length) return undefined;
  return { reply, confidence: "low", actions, clarify: options.length ? { question: turn.clarify.question, options } : { question: "", options: [] }, corrects: turn.corrects };
}

function normalizeTurn(raw: unknown): ConciergeTurn {
  const value = raw as Partial<ConciergeTurn> | undefined;
  if (!value || typeof value !== "object" || !Array.isArray(value.actions)) throw new Error("CONCIERGE_SHAPE_INVALID");
  const actions = value.actions.filter((item): item is ProposedAction => Boolean(item) && isActionId((item as { action?: unknown }).action)
    && typeof (item as { args?: unknown }).args === "object").slice(0, 8)
    .map((item) => ({ ...item, summary: String(item.summary ?? "").trim().slice(0, 200) }) as ProposedAction);
  const clarify = value.clarify && typeof value.clarify.question === "string" && value.clarify.question.trim()
    ? { question: value.clarify.question.trim().slice(0, 300), options: (Array.isArray(value.clarify.options) ? value.clarify.options : []).slice(0, 4)
        .map((option) => ({ label: String(option?.label ?? "").trim().slice(0, 60),
          actions: (Array.isArray(option?.actions) ? option.actions : []).filter((index) => Number.isInteger(index) && index >= 0 && index < actions.length) }))
        .filter((option) => option.label) }
    : { question: "", options: [] };
  return { reply: String(value.reply ?? "").trim().slice(0, 1500), confidence: value.confidence === "low" ? "low" : "high", actions, clarify,
    corrects: value.corrects === true };
}

/**
 * Whether the first, quick reading gets a second look on the stronger model (先快后准, docs/one-input.md §3.5): the model said it was
 * unsure, the repairs had to drop something, or the card changes several things at once — three actions, or two different objects.
 * A plain answer is never looked at twice.
 */
export function needsReview(turn: ConciergeTurn, warnings: string[] = []): boolean {
  if (!turn.actions.length) return false;
  if (turn.confidence === "low" || warnings.length) return true;
  const objects = new Set(turn.actions.map((item) => {
    const args = item.args as Record<string, unknown>;
    return String(args.workOrderId ?? args.askId ?? args.opId ?? args.taskId ?? args.milestoneId ?? (Array.isArray(args.milestoneIds) ? args.milestoneIds.join(",") : "") ?? item.action);
  }).filter(Boolean));
  return turn.actions.length >= 3 || objects.size >= 2;
}

/** The candidate actions a clarify option names are not shown as cards of their own: they run only when that option is chosen. */
export function cardActionIndexes(turn: ConciergeTurn): number[] {
  const candidates = new Set(turn.clarify.options.flatMap((option) => option.actions));
  return turn.actions.map((_, index) => index).filter((index) => !candidates.has(index));
}

/** A flat template criterion as the stored shape, or undefined when its measure lacks what that kind needs. */
export function templateCriterion(raw: TemplateCriterion, index: number): import("./index").SuccessCriterion | undefined {
  const base = { id: `c${index + 1}`, statement: raw.statement.trim().slice(0, 300), required: raw.required, evidenceOf: raw.evidenceOf };
  switch (raw.measure) {
    case "count": return raw.unit && raw.number > 0 ? { ...base, measure: { kind: "count", unit: raw.unit, atLeast: raw.number } } : undefined;
    case "threshold": return raw.unit && (raw.comparator === "gte" || raw.comparator === "lte")
      ? { ...base, measure: { kind: "threshold", unit: raw.unit, comparator: raw.comparator, value: raw.number } } : undefined;
    case "artifact": return raw.mustExist ? { ...base, measure: { kind: "artifact", mustExist: raw.mustExist } } : undefined;
    case "judgement": return raw.rubric && raw.failsWhen ? { ...base, measure: { kind: "judgement", rubric: raw.rubric, failsWhen: raw.failsWhen } } : undefined;
  }
}

/** The words on the card for one action: its verb and the model's one-line summary. */
export const actionLabel = (item: ProposedAction): string => ACTIONS[item.action].label;

/**
 * What the web knows right now, handed to the worker with each turn (docs/one-input.md §3.2). Only the short `snapshot` goes into the
 * prompt; the model reads the rest through the lookup tools, so a turn stays small however much the account holds, and every lookup
 * sees the state of the moment the person pressed send.
 */
export type ConciergePack = {
  now: string; today: string; timeZone: string;
  /** `stepId`: on a task, the step the person is looking at (a picked block on Today's day panel); absent, the first open step. */
  page: { kind: string; entityId: string; title: string; stepId?: string };
  /** `description` is the interview's reading of the line (`lines.profiles`), "" before one exists. */
  lines: Array<{ id: string; label: string; goals: string[]; hard: boolean; description: string; domain?: string }>;
  tasks: Array<{ id: string; title: string; line: string; project: string; state: string; dueDate: string; notBefore: string; usualMinutes: number;
    nextBlock: string; steps: Array<{ id: string; title: string; status: string; minutes: number; executor: string }> }>;
  proposals: Array<{ id: string; title: string; line: string }>;
  milestones: Array<{ id: string; title: string; line: string; status: string; deadline: string; weight: number }>;
  asks: Array<{ id: string; kind: string; title: string; why: string; urgency: string;
    options: Array<{ id: string; label: string; fields: Array<{ id: string; label: string; required: boolean }> }> }>;
  plan: Array<{ day: string; start: string; end: string; title: string; kind: string }>;
  /** Per day of the next seven: the person's available hours minus fixed arrangements (what work can use), and what work already holds. */
  capacity: Array<{ day: string; availableMinutes: number; scheduledMinutes: number }>;
  /** The weekly pattern the plan uses, one band per item (「周一 周二 09:00–12:00 高」), so `availability.set` can change part of it. */
  weeklyPattern?: string[];
  ops: Array<{ id: string; label: string; at: string }>;
  agentResults: Array<{ taskId: string; title: string; summary: string }>;
  materials: Array<{ id: string; fileName: string; project: string }>;
  /** The person's projects (courses, papers, accounts), by line. */
  projects: Array<{ id: string; name: string; line: string }>;
  facts: string[];
  /** The person's standing preferences and their earlier corrections of how the box read them, newest and weightiest first. */
  preferences: string[];
  energy: { level: string; at: string } | null;
  forecast: Array<{ milestoneId: string; title: string; deadline: string; usualFinish: string; cautiousFinish: string; atRisk: boolean }>;
  /** The person's automations (what runs by itself) and how many mailboxes are connected (docs/personal-agent.md). */
  automations?: Array<{ name: string; trigger: string; status: string; lineId?: string }>;
  mailboxes?: number;
  /**
   * Getting around (docs/one-input.md 「生活与日程」): whether a home and a work or school address are set (a map then estimates travel),
   * the default travel minutes, the places whose minutes the person gave, and the reminders still to be said.
   */
  life?: { home: boolean; work: boolean; defaultMinutes: number; places: string[]; reminders: string[] };
};

export function conciergeRefs(pack: ConciergePack): ConciergeRefs {
  return {
    tasks: new Map(pack.tasks.map((task) => [task.id, new Set(task.steps.map((step) => step.id))])),
    asks: new Map(pack.asks.map((ask) => [ask.id, new Set(ask.options.map((option) => option.id))])),
    ops: new Set(pack.ops.map((op) => op.id)), lines: new Set(pack.lines.map((line) => line.id)),
    milestones: new Set(pack.milestones.map((item) => item.id)), draftMilestones: new Set(pack.milestones.filter((item) => item.status === "draft").map((item) => item.id)),
    proposals: new Set(pack.proposals.map((item) => item.id)), agentResults: new Set(pack.agentResults.map((item) => item.taskId)), today: pack.today,
    documents: new Set(pack.materials.map((item) => item.id)), projects: new Set(pack.projects.map((item) => item.id))
  };
}

const QUERY = { type: "object", properties: { query: { type: "string", description: "关键词（标题、课程、项目或主线）；空字符串列出全部" } }, required: ["query"], additionalProperties: false };
const ID = { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false };
const NONE = { type: "object", properties: {}, additionalProperties: false };

/** The lookups (read-only). `read_material` is answered by the worker from the stored file text; the rest from the pack. */
export const CONCIERGE_TOOL_SPECS = [
  { name: "find_tasks", description: "按关键词查打开的任务（含待批准提案）：id、标题、主线、项目、状态、截止、下一个时段", inputSchema: QUERY },
  { name: "get_task", description: "一个任务的详情：步骤（id、标题、状态、时长、执行者）、截止、最早开始", inputSchema: ID },
  { name: "find_milestones", description: "按关键词查里程碑：id、标题、主线、状态（draft 为草稿）、截止、重要性", inputSchema: QUERY },
  { name: "list_asks", description: "所有待决事项：id、标题、原因、紧急程度、选项 id 与需要填写的字段", inputSchema: NONE },
  { name: "get_plan", description: "未来 7 天的日程与排程块（日期、起止、标题、类型），以及每天的可用分钟（可用时段扣除固定安排）与已排任务分钟", inputSchema: { type: "object",
    properties: { day: { type: "string", description: "YYYY-MM-DD；空字符串为全部 7 天" } }, required: ["day"], additionalProperties: false } },
  { name: "list_recent_ops", description: "最近 24 小时本人的可撤销操作：id、标签、时间，最新在前", inputSchema: NONE },
  { name: "list_agent_results", description: "等待本人审阅的助手成果：taskId、标题、摘要", inputSchema: NONE },
  { name: "get_forecast", description: "已批准里程碑的完成预测：通常与保守完成日、是否有风险", inputSchema: NONE },
  { name: "find_materials", description: "按关键词查已上传的文件：id、文件名、项目", inputSchema: QUERY },
  { name: "list_projects", description: "本人的项目（课程、论文、账户等）：id、名称、主线", inputSchema: NONE },
  { name: "read_material", description: "读一个文件的文本（从 offset 起约 6000 字）", inputSchema: { type: "object",
    properties: { id: { type: "string" }, offset: { type: "integer" } }, required: ["id", "offset"], additionalProperties: false } },
  { name: "get_profile_facts", description: "本人确认过的情况（背景、课程评分、目标等），按关键词筛选", inputSchema: QUERY }
] as const;

const matches = (query: string, ...texts: string[]) => {
  const q = query.trim().toLowerCase();
  return !q || texts.some((text) => text.toLowerCase().includes(q)) || q.split(/\s+/).every((word) => texts.some((text) => text.toLowerCase().includes(word)));
};

/** Answers one lookup from the pack, as compact JSON. `read_material` is not answered here (the caller has the file text). */
export function answerFromPack(pack: ConciergePack, name: string, args: Record<string, unknown>): string {
  const query = String(args.query ?? "");
  const id = String(args.id ?? "");
  const json = (value: unknown) => JSON.stringify(value);
  switch (name) {
    case "find_tasks": return json([...pack.tasks.map(({ steps: _steps, ...task }) => task), ...pack.proposals.map((item) => ({ ...item, project: "", state: "awaiting_plan_approval" }))]
      .filter((task) => matches(query, task.title, task.line, task.project)).slice(0, 30));
    case "get_task": { const task = pack.tasks.find((item) => item.id === id); return task ? json(task) : `没有 id 为 ${id} 的打开任务`; }
    case "find_milestones": return json(pack.milestones.filter((item) => matches(query, item.title, item.line)).slice(0, 30));
    case "list_asks": return json(pack.asks);
    case "get_plan": return json({ blocks: pack.plan.filter((block) => !args.day || block.day === args.day),
      capacity: pack.capacity.filter((day) => !args.day || day.day === args.day) });
    case "list_recent_ops": return json(pack.ops);
    case "list_agent_results": return json(pack.agentResults);
    case "get_forecast": return json(pack.forecast);
    case "find_materials": return json(pack.materials.filter((item) => matches(query, item.fileName, item.project)).slice(0, 30));
    case "list_projects": return json(pack.projects);
    case "get_profile_facts": return json(pack.facts.filter((fact) => matches(query, fact)).slice(0, 40));
    default: return `没有名为 ${name} 的查询`;
  }
}
