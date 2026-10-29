import { isAgentCategory, type AgentCategory } from "./agent-dispatch";
import { joinList, tFor, type Locale } from "./i18n";
import { monthlyFromDays, stepLeavesMachine, workflowDue, scheduleLabel, WEEKDAYS, type Weekday, type WorkflowSchedule } from "./workflows";

/**
 * Automations (docs/personal-agent.md, 2026-10-19): what the person asks for in words — 「每天早上 8 点把邮箱里和课程有关的整理成清单」,
 * 「课程网页一更新就告诉我改了什么」, 「每周五把这周新上传的材料归档」 — kept as a trigger and an action, the way n8n keeps a workflow,
 * and run end to end by the assistant on whatever model serves the account. A trigger is deterministic and costs nothing to watch
 * (a time, an interval, new mail matching a filter, a public page whose text changed, a new file, a task finished or coming due); only a
 * firing starts a model run. The action is a run of the assistant with the automation's instructions and what fired it as input, or a
 * plain reminder. Nothing an automation does leaves Crossline: the assistant has no function to send, publish or pay, and steps of that
 * kind are the person's.
 */
export const AUTOMATIONS_SETTING = "automations";
export const AUTOMATION_RUNS_SETTING = "automations.runs";
export const AUTOMATIONS_MAX = 20;

export type AutomationTrigger =
  | { type: "schedule"; schedule: WorkflowSchedule }
  | { type: "interval"; hours: number }
  | { type: "mail"; from: string; keywords: string[] }
  | { type: "watch"; url: string; hours: number }
  | { type: "file"; keywords: string[] }
  | { type: "task"; event: "accepted" | "due_soon"; lineId: string };
export type AutomationAction =
  | { kind: "run"; instructions: string; category: AgentCategory; outputs: string[] }
  | { kind: "remind"; text: string };
export type Automation = {
  id: string; name: string; summary: string; lineId: string; status: "active" | "off";
  trigger: AutomationTrigger; action: AutomationAction;
  /** What it does, step by step; a step that leaves Crossline is the person's and is said so. */
  steps: Array<{ title: string; by: "assistant" | "person" }>;
  origin: { kind: "asked"; text: string; requestId: string };
  createdAt: string; updatedAt: string;
  lastFiredAt?: string; runs: number;
  /** A watched page's text fingerprint and when it was last read. */
  watch?: { hash: string; checkedAt: string; excerpt: string };
  /**
   * The assistant's conversation this automation goes on in (2026-10-20): each firing is a new turn on it, so a run knows what the last
   * ones did. Replaced when the runtime no longer has it.
   */
  threadId?: string;
  /** What its last finished run did and where that run's files are, handed to the next run (and to a new thread, as history). */
  lastRun?: { taskId: string; at: string; summary: string; directory: string; files: string[] };
};
/** The part of the next run's instructions that says what the last run did; empty before the first. An instruction to the assistant. */
/* i18n-ignore-start */
export function previousRunNote(lastRun: Automation["lastRun"]): string {
  if (!lastRun) return "";
  const files = lastRun.files.slice(0, 8);
  return `上次运行（${lastRun.at.slice(0, 16).replace("T", " ")}）做了：${lastRun.summary.slice(0, 600)}`
    + `${files.length ? `\n上次的产出已作为只读输入给这次运行：${files.map((file) => file.split(/[\\/]/).pop()).join("、")}${lastRun.files.length > files.length ? ` 等 ${lastRun.files.length} 个文件` : ""}` : ""}`
    + "\n这次接着上次做：已经做过、没有变化的不要重做，只处理新的部分；需要上次的内容时读上次的产出。";
}
/* i18n-ignore-end */
export type AutomationRun = { automationId: string; taskId: string; firedAt: string; reason: string; state: "started" | "reminded" | "queued" | "skipped"; detail?: string };

export function readAutomations(raw: string | null | undefined): Automation[] {
  try { const parsed = JSON.parse(raw ?? "[]") as Automation[]; return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === "string") : []; }
  catch { return []; }
}
export function readAutomationRuns(raw: string | null | undefined): AutomationRun[] {
  try { const parsed = JSON.parse(raw ?? "[]") as AutomationRun[]; return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

/** What the designer answers: flat, so it keeps within the strict-mode depth limit on every model. */
export type AutomationPlan = {
  name: string; summary: string; lineId: string;
  trigger: { type: AutomationTrigger["type"]; time: string; days: string; hours: number; from: string; keywords: string; url: string; event: string };
  action: { kind: "run" | "remind"; instructions: string; reminder: string; category: string; outputs: string };
  steps: Array<{ title: string; by: "assistant" | "person" }>;
  assumptions: string;
  /** The id of an existing automation this request changes (「把邮件整理改成每天两次」), or "" for a new one. */
  replaces: string;
  /** False when the request is to stop one for now (「先停掉那个网页监控」); it is kept, paused. */
  enabled: boolean;
};
const str = (max: number) => ({ type: "string", maxLength: max }) as const;
export const AUTOMATION_PLAN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["name", "summary", "lineId", "trigger", "action", "steps", "assumptions", "replaces", "enabled"], properties: {
    name: str(40), summary: str(200), lineId: str(64),
    trigger: { type: "object", additionalProperties: false, required: ["type", "time", "days", "hours", "from", "keywords", "url", "event"], properties: {
      type: { type: "string", enum: ["schedule", "interval", "mail", "watch", "file", "task"] }, time: str(5), days: str(40),
      hours: { type: "integer", minimum: 0, maximum: 168 }, from: str(120), keywords: str(200), url: str(500), event: { type: "string", enum: ["", "accepted", "due_soon"] } } },
    action: { type: "object", additionalProperties: false, required: ["kind", "instructions", "reminder", "category", "outputs"], properties: {
      kind: { type: "string", enum: ["run", "remind"] }, instructions: str(2000), reminder: str(200), category: str(40), outputs: str(300) } },
    steps: { type: "array", minItems: 1, maxItems: 12, items: { type: "object", additionalProperties: false, required: ["title", "by"], properties: {
      title: str(120), by: { type: "string", enum: ["assistant", "person"] } } } },
    assumptions: str(400), replaces: str(40), enabled: { type: "boolean" } }
} as const;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// Items are split on commas, semicolons and line breaks only: an output like 「一份 Markdown 清单」 has spaces inside it.
const list = (text: string) => text.split(/[,，、;；\n]+/).map((item) => item.trim()).filter(Boolean).slice(0, 12);
const problem = (detail: string): never => { throw Object.assign(new Error("AUTOMATION_PLAN_INVALID"), { detail }); };

/** The page a watch may read: public https, no IP literal, no local name. */
export function watchUrlAllowed(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && !parsed.port && !/^\d+(\.\d+){3}$|^\[/.test(parsed.hostname) && parsed.hostname.includes(".")
      && !/(^|\.)(localhost|local|internal|lan)$/i.test(parsed.hostname);
  } catch { return false; }
}

/**
 * Reading or sorting mail is not sending it. The shared external-action pattern counts the noun 邮件 itself as an act, so a mail
 * automation's own work (「读新邮件并整理成清单」) was handed to the person and the assistant was told the person does it. Here the noun
 * alone does not count; the acts done to mail still do (sending, replying, forwarding, deleting, submitting).
 */
const MAIL_NOUN = /邮件|来信/g;
const MAIL_ACT = /回复|答复|转发|抄送|群发|发(一?封)?(邮件|信)(?!人)|发给|发出|寄给|寄出|\b(reply|forward)\b/i;
/** Drafting a reply is the assistant's (「起草回复存成草稿」); sending it is not. */
const DRAFTS_REPLY = /(起草|草拟|拟定?|准备)[^，。；,.;]{0,8}?(回复|答复)|(回复|答复)(稿|草稿)/g;
export const automationStepLeaves = (title: string) => {
  const drafted = title.replace(DRAFTS_REPLY, "");
  return MAIL_ACT.test(drafted) || stepLeavesMachine(drafted.replace(MAIL_NOUN, ""));
};

/** Turns the designer's answer into a stored automation's parts, or says what is wrong so the designer can fix it (repair messages). */
/* i18n-ignore-start */
export function validateAutomationPlan(value: unknown, lineIds: string[], existingIds: string[] = []):
  Pick<Automation, "name" | "summary" | "lineId" | "trigger" | "action" | "steps"> & { assumptions: string; replaces: string; enabled: boolean } {
  const plan = value as AutomationPlan | undefined;
  if (!plan || typeof plan !== "object" || !plan.trigger || !plan.action) return problem("回答缺少 trigger 或 action");
  const replaces = typeof plan.replaces === "string" ? plan.replaces.trim() : "";
  if (replaces && !existingIds.includes(replaces)) problem(`replaces「${replaces}」不是已有自动化的 id；新建时写 ""`);
  if (!plan.name?.trim()) problem("name 不能为空");
  if (!lineIds.includes(plan.lineId)) problem(`lineId 只能是 ${lineIds.join("、")}`);
  const t = plan.trigger;
  let trigger: AutomationTrigger;
  switch (t.type) {
    case "schedule": {
      if (!TIME.test(t.time)) problem("schedule 的 time 须为 HH:MM");
      const days = list(t.days.toUpperCase()).filter((day): day is Weekday => (WEEKDAYS as readonly string[]).includes(day));
      const schedule: WorkflowSchedule = monthlyFromDays(t.days, t.time) ?? (!t.days.trim() || /DAILY|每天/i.test(t.days) ? { type: "daily", time: t.time }
        : /WEEKDAYS|工作日/i.test(t.days) ? { type: "weekdays", time: t.time }
        : days.length ? { type: "weekly", days, time: t.time } : problem("schedule 的 days 写 DAILY、WEEKDAYS、MO,TU,…、MONTHLY:日 或 QUARTERLY:日"));
      trigger = { type: "schedule", schedule };
      break;
    }
    case "interval": if (t.hours < 1) problem("interval 的 hours 至少为 1"); trigger = { type: "interval", hours: t.hours }; break;
    case "mail": trigger = { type: "mail", from: t.from.trim().toLowerCase(), keywords: list(t.keywords) }; break;
    case "watch":
      if (!watchUrlAllowed(t.url.trim())) problem("watch 的 url 须是公开的 https 网页地址");
      trigger = { type: "watch", url: t.url.trim(), hours: Math.max(1, t.hours || 6) }; break;
    case "file": trigger = { type: "file", keywords: list(t.keywords) }; break;
    case "task":
      if (t.event !== "accepted" && t.event !== "due_soon") problem("task 的 event 须为 accepted 或 due_soon");
      trigger = { type: "task", event: t.event as "accepted" | "due_soon", lineId: lineIds.includes(t.from) ? t.from : "" }; break;
    default: return problem("trigger.type 不认识");
  }
  const a = plan.action;
  let action: AutomationAction;
  if (a.kind === "remind") {
    if (!a.reminder.trim()) problem("remind 须写明提醒的话");
    action = { kind: "remind", text: a.reminder.trim() };
  } else {
    if (a.instructions.trim().length < 10) problem("run 的 instructions 须写清每次运行要做什么（至少 10 个字）");
    if (!isAgentCategory(a.category)) problem("category 不是已知的助手工作类别");
    action = { kind: "run", instructions: a.instructions.trim(), category: a.category as AgentCategory, outputs: list(a.outputs) };
  }
  if (!Array.isArray(plan.steps) || !plan.steps.length) problem("steps 至少一步");
  // Anything that sends, uploads, publishes or pays is the person's, whatever the plan says.
  const steps = plan.steps.map((step) => ({ title: step.title.trim(), by: automationStepLeaves(step.title) ? "person" as const : step.by }));
  return { name: plan.name.trim(), summary: plan.summary.trim(), lineId: plan.lineId, trigger, action, steps, assumptions: plan.assumptions.trim(), replaces,
    enabled: plan.enabled !== false };
}
/* i18n-ignore-end */

/** In words, for the settings card and the message that says it was made. */
export function triggerLabel(trigger: AutomationTrigger, locale?: Locale): string {
  const t = tFor(locale);
  const words = (keywords: string[]) => locale === "en" ? joinList(locale, keywords.map((word) => `"${word}"`)) : keywords.join("、");
  switch (trigger.type) {
    case "schedule": return scheduleLabel(trigger.schedule, locale);
    case "interval": return t("每 {{count}} 小时", { count: trigger.hours });
    case "mail": {
      const from = trigger.from, keywords = trigger.keywords.length ? words(trigger.keywords) : "";
      if (from && keywords) return t("收到 {{from}} 的含「{{keywords}}」的邮件时", { from, keywords });
      if (from) return t("收到 {{from}} 的新邮件时", { from });
      return keywords ? t("收到含「{{keywords}}」的邮件时", { keywords }) : t("收到新邮件时");
    }
    case "watch": { let host = trigger.url; try { host = new URL(trigger.url).hostname; } catch { /* as typed */ }
      return t("{{host}} 的页面内容变化时（每 {{count}} 小时看一次）", { host, count: trigger.hours }); }
    case "file": return trigger.keywords.length ? t("添加了含「{{keywords}}」的文件时", { keywords: words(trigger.keywords) }) : t("添加了新文件时");
    case "task": return trigger.event === "accepted" ? t("任务完成验收时") : t("任务明天到期时");
  }
}

/**
 * Whether a time-based trigger is due now: schedule — its time today; interval — N hours since the last firing; watch — N hours since
 * the page was last read (reading it is free; it fires only when the text changed).
 */
export function timeTriggerDue(automation: Pick<Automation, "trigger" | "lastFiredAt" | "createdAt" | "watch">, now: Date, zone: string): boolean {
  const { trigger } = automation;
  if (trigger.type === "schedule") return workflowDue(trigger.schedule, automation.lastFiredAt, now, zone);
  if (trigger.type === "interval") return now.getTime() - Date.parse(automation.lastFiredAt ?? automation.createdAt) >= trigger.hours * 3_600_000;
  if (trigger.type === "watch") return !automation.watch || now.getTime() - Date.parse(automation.watch.checkedAt) >= trigger.hours * 3_600_000;
  return false;
}

const words = (text: string) => text.toLowerCase();
/** A new message matches when its sender contains `from` (if given) and its subject or opening has any keyword (if given). */
export function mailMatches(trigger: Extract<AutomationTrigger, { type: "mail" }>, message: { from: string; subject: string; snippet: string }): boolean {
  if (trigger.from && !words(message.from).includes(trigger.from)) return false;
  return !trigger.keywords.length || trigger.keywords.some((keyword) => words(`${message.subject} ${message.snippet}`).includes(words(keyword)));
}
export function fileMatches(trigger: Extract<AutomationTrigger, { type: "file" }>, file: { fileName: string; text: string }): boolean {
  return !trigger.keywords.length || trigger.keywords.some((keyword) => words(`${file.fileName} ${file.text.slice(0, 4000)}`).includes(words(keyword)));
}

/** Lines that were not in the old text: what changed on a watched page, shown to the run and the person. */
export function addedLines(before: string, after: string, max = 40): string[] {
  const old = new Set(before.split("\n").map((line) => line.trim()).filter(Boolean));
  return after.split("\n").map((line) => line.trim()).filter((line) => line && !old.has(line)).slice(0, max);
}
