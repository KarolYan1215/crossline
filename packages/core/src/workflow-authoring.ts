import { AUTOMATION_PLAN_SCHEMA, triggerLabel, validateAutomationPlan, automationStepLeaves, type Automation } from "./automations";
import { tFor, type Locale } from "./i18n";
import { scheduleLabel, stepLeavesMachine, workflowDue, type GrownSkillRecord, type WorkflowManifest, type WorkflowSchedule } from "./workflows";

/**
 * 自动化 page (2026-11-10, docs/claude/skill-library.md 「工作流」): automations and grown workflows are one thing to the person — a 工作流,
 * its kind shown as a tag — each with its own conversation to make or change it, every change kept as a version that can be compared,
 * tried without effect and gone back to. Storage: the `workflows`, `workflow_versions`, `workflow_threads` and `workflow_turns` tables
 * (migration 24); the old settings keys are read and written through them (`CrosslineStore.getSetting`).
 */
export type WorkflowKind = "automation" | "grown";

/** The parts of an automation a version keeps: what it does and when, not its run bookkeeping or whether it is paused. */
export type AutomationDefinition = Pick<Automation, "name" | "summary" | "lineId" | "trigger" | "action" | "steps">;
export const automationDefinition = (automation: AutomationDefinition): AutomationDefinition => ({
  name: automation.name, summary: automation.summary, lineId: automation.lineId, trigger: automation.trigger, action: automation.action, steps: automation.steps
});

/** Where a version came from: the import of the old settings, a change made anywhere, a turn of its conversation, a rollback. */
export type WorkflowVersionSource = "import" | "created" | "change" | "thread" | "rollback" | "grown";
export type StoredWorkflowVersion = { kind: WorkflowKind; workflowId: string; version: number; data: unknown; source: WorkflowVersionSource; note: string; turnId: string; createdAt: string };

/** One thing said or done in a workflow's conversation. Tool calls are shown as they ran, with what they were asked and answered. */
export type WorkflowTurnItem = { type: "tool"; name: string; args: string; result: string; ok: boolean } | { type: "version"; version: number; note: string }
  | { type: "status"; text: string };
export type WorkflowTurn = {
  workspaceId: string; id: string; threadId: string; ord: number; role: "person" | "assistant" | "system";
  text: string; items: WorkflowTurnItem[]; state: "running" | "done" | "failed"; createdAt: string; updatedAt: string;
};
/** A workflow's conversation. `workflowId` is "" while a new one is still being made (its first request not yet designed). */
export type WorkflowThread = {
  workspaceId: string; id: string; workflowId: string; kind: WorkflowKind; codexThreadId: string; lineId: string; title: string; createdAt: string; updatedAt: string;
};

/** A version as text, line by line, for the diff: what it does in words first, then the rest as stored. */
export function renderAutomationVersion(definition: AutomationDefinition, locale?: Locale): string {
  const t = tFor(locale);
  const action = definition.action;
  return [
    `${t("名称")}: ${definition.name}`, `${t("说明")}: ${definition.summary}`, `${t("主线")}: ${definition.lineId}`,
    `${t("触发")}: ${triggerLabel(definition.trigger, locale)}`,
    action.kind === "remind" ? `${t("提醒")}: ${action.text}` : `${t("类别")}: ${action.category}`,
    ...(action.kind === "run" ? [`${t("要交出")}: ${action.outputs.join(", ")}`, `${t("指示")}:`, ...action.instructions.split("\n").map((line) => `  ${line}`)] : []),
    `${t("步骤")}:`, ...definition.steps.map((step, index) => `  ${index + 1}. ${step.title}${step.by === "person" ? ` (${t("本人")})` : ""}`)
  ].join("\n");
}

export function renderGrownVersion(version: { manifest: WorkflowManifest; files: Array<{ path: string; text: string }> }, locale?: Locale): string {
  const t = tFor(locale);
  const manifest = version.manifest;
  return [
    `${t("名称")}: ${manifest.name}`, `${t("说明")}: ${manifest.summary}`, `${t("类别")}: ${manifest.category}`,
    `${t("触发")}: ${manifest.trigger === "schedule" && manifest.schedule ? scheduleLabel(manifest.schedule, locale) : t("用到时")}`,
    `${t("步骤")}:`, ...manifest.steps.map((step, index) => `  ${index + 1}. ${step.title}${step.by === "person" || step.external ? ` (${t("本人")})` : ""}`),
    ...(manifest.access ?? []).map((item) => `${t("读取")}: ${item.service} ${item.site}${item.login ? ` (${t("登录")})` : ""}`),
    ...[...version.files].sort((a, b) => a.path.localeCompare(b.path)).flatMap((file) => [`--- ${file.path}`, ...file.text.split("\n")])
  ].join("\n");
}

export type DiffLine = { op: "same" | "add" | "del"; text: string };
/**
 * A line diff (longest common subsequence). Past `limit` lines on either side it degrades to removing the old and adding the new rather
 * than spending quadratic time on a file nobody reads line by line.
 */
export function lineDiff(before: string, after: string, limit = 1500): DiffLine[] {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length > limit || b.length > limit) return [...a.map((text) => ({ op: "del" as const, text })), ...b.map((text) => ({ op: "add" as const, text }))];
  const rows = a.length + 1, cols = b.length + 1;
  const table = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] = a[i] === b[j] ? table[(i + 1) * cols + j + 1]! + 1 : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ op: "same", text: a[i]! }); i += 1; j += 1; }
    else if (table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!) { out.push({ op: "del", text: a[i]! }); i += 1; }
    else { out.push({ op: "add", text: b[j]! }); j += 1; }
  }
  while (i < a.length) out.push({ op: "del", text: a[i++]! });
  while (j < b.length) out.push({ op: "add", text: b[j++]! });
  return out;
}

/** The next times a schedule fires after `from`, in the person's zone: scanned every half hour, then to the minute. */
export function nextScheduleTimes(schedule: WorkflowSchedule, from: Date, zone: string, count = 3, horizonDays = 100): string[] {
  const out: string[] = [];
  let last: string | undefined;
  const step = 30 * 60_000;
  const end = from.getTime() + horizonDays * 86_400_000;
  for (let at = from.getTime() + step; at <= end && out.length < count; at += step) {
    if (!workflowDue(schedule, last, new Date(at), zone)) continue;
    let hit = at;
    while (hit - 60_000 > at - step && workflowDue(schedule, last, new Date(hit - 60_000), zone)) hit -= 60_000;
    out.push(new Date(hit).toISOString());
    last = new Date(hit).toISOString();
  }
  return out;
}

/**
 * 试运行: what a version would do if it fired now, worked out without running anything — no model call, no file written, no message,
 * no run counted. The next times it would fire, what sets it off, what the assistant would be told, which steps are the person's, and the
 * checks a real run goes through.
 */
export type WorkflowDryRun = {
  kind: WorkflowKind; version: number; trigger: string; next: string[]; waitsFor: string;
  steps: Array<{ title: string; by: "assistant" | "person"; leaves: boolean }>;
  prompt: string; reminder: string; outputs: string[]; checks: Array<{ ok: boolean; text: string }>;
};

/** What a firing of an automation tells the assistant (the same words `fire` sends; model-facing). */
/* i18n-ignore-start */
export function automationRunPrompt(action: Extract<Automation["action"], { kind: "run" }>, why: { reason: string; context: string }, note: string): string {
  return `${action.instructions}\n\n这次运行的原因：${why.reason}${why.context ? `\n\n${why.context}` : ""}${note ? `\n\n${note}` : ""}${action.outputs.length ? `\n\n要交出：${action.outputs.join("、")}` : ""}`;
}
/* i18n-ignore-end */

export function dryRunAutomation(definition: AutomationDefinition & Pick<Automation, "lastFiredAt" | "createdAt">, version: number,
  options: { now: Date; zone: string; locale?: Locale; categoryOn: boolean }): WorkflowDryRun {
  const t = tFor(options.locale);
  const trigger = definition.trigger;
  const next = trigger.type === "schedule" ? nextScheduleTimes(trigger.schedule, options.now, options.zone)
    : trigger.type === "interval" || trigger.type === "watch"
      ? [1, 2, 3].map((n) => new Date(Math.max(options.now.getTime(), Date.parse(definition.lastFiredAt ?? definition.createdAt)) + n * trigger.hours * 3_600_000).toISOString())
      : [];
  const waitsFor = trigger.type === "mail" ? t("等到符合条件的新邮件")
    : trigger.type === "file" ? t("等到符合条件的新文件") : trigger.type === "task" ? t("等到任务事件")
    : trigger.type === "watch" ? t("页面文字变了才运行；看页面本身不调用模型") : "";
  const action = definition.action;
  const steps = definition.steps.map((step) => ({ title: step.title, by: step.by, leaves: automationStepLeaves(step.title) }));
  const checks = [
    { ok: steps.every((step) => !step.leaves || step.by === "person"), text: t("发送、回复、发布、上传、付款一类的步骤都由本人完成") },
    ...(action.kind === "run" ? [{ ok: options.categoryOn, text: options.categoryOn ? t("助手的这类工作已开启") : t("助手的这类工作已关闭，真正运行时会跳过") }] : []),
    { ok: true, text: t("试运行没有调用模型，没有写文件、发消息，也不计入运行次数") }
  ];
  return { kind: "automation", version, trigger: triggerLabel(trigger, options.locale), next, waitsFor, steps,
    prompt: action.kind === "run" ? automationRunPrompt(action, { reason: t("试运行"), context: "" }, "") : "",
    reminder: action.kind === "remind" ? action.text : "", outputs: action.kind === "run" ? action.outputs : [], checks };
}

export function dryRunGrown(record: Pick<GrownSkillRecord, "status" | "scan" | "review" | "lastRunAt">, version: { version: number; manifest: WorkflowManifest },
  options: { now: Date; zone: string; locale?: Locale; consented: boolean }): WorkflowDryRun {
  const t = tFor(options.locale);
  const manifest = version.manifest;
  const scheduled = manifest.trigger === "schedule" && manifest.schedule;
  const steps = manifest.steps.map((step) => ({ title: step.title, by: step.external ? "person" as const : step.by, leaves: step.external || stepLeavesMachine(step.title) }));
  const reads = (manifest.access ?? []).length > 0;
  const checks = [
    { ok: steps.every((step) => !step.leaves || step.by === "person"), text: t("发送、回复、发布、上传、付款一类的步骤都由本人完成") },
    { ok: record.review.final !== "reject", text: t("安装前的代码扫描与审查：{{verdict}}", { verdict: record.review.final === "usable" ? t("可用") : record.review.final === "text_only" ? t("只用文字") : t("拒绝") }) },
    ...(reads ? [{ ok: options.consented, text: options.consented ? t("本人已同意它读取的网站与风险") : t("它要读取网站，本人同意风险前不会运行") }] : []),
    { ok: true, text: t("试运行没有调用模型，没有写文件、发消息，也不计入运行次数") }
  ];
  return { kind: "grown", version: version.version, trigger: scheduled ? scheduleLabel(manifest.schedule!, options.locale) : t("有这类任务时使用"),
    next: scheduled ? nextScheduleTimes(manifest.schedule!, options.now, options.zone) : [], waitsFor: scheduled ? "" : t("等到这条主线上出现这类任务"),
    steps, prompt: manifest.action === "run" || !scheduled ? `$crossline-grown:… ${manifest.summary}` : "", reminder: manifest.action === "remind" ? manifest.reminder : "",
    outputs: manifest.outputs, checks };
}

/**
 * One turn of a workflow's conversation, as the designer answers it: what it says to the person (`reply`, first so it can be shown while
 * it streams), and whether the turn changes the workflow — `automation`: the whole automation in `plan` (as `AUTOMATION_PLAN_SCHEMA`);
 * `revise`: a grown workflow's files are to be revised, with what to change in `revision` (the improver does it and checks it like a new
 * one); `none`: a question or an explanation, nothing changed.
 */
export const WORKFLOW_TURN_SCHEMA = {
  type: "object", additionalProperties: false, required: ["reply", "change", "plan", "revision"], properties: {
    reply: { type: "string", maxLength: 1500 },
    change: { type: "string", enum: ["none", "automation", "revise"] },
    plan: AUTOMATION_PLAN_SCHEMA,
    revision: { type: "string", maxLength: 2000 }
  }
} as const;

export type WorkflowTurnAnswer =
  | { reply: string; change: "none" }
  | { reply: string; change: "automation"; plan: ReturnType<typeof validateAutomationPlan> }
  | { reply: string; change: "revise"; revision: string };

/* i18n-ignore-start */
export function validateWorkflowTurn(value: unknown, context: { kind: WorkflowKind; workflowId: string; lineIds: string[] }): WorkflowTurnAnswer {
  const answer = value as { reply?: unknown; change?: unknown; plan?: unknown; revision?: unknown } | undefined;
  const fail = (detail: string): never => { throw Object.assign(new Error("WORKFLOW_TURN_INVALID"), { detail }); };
  if (!answer || typeof answer !== "object") return fail("回答不是对象");
  const reply = typeof answer.reply === "string" ? answer.reply.trim() : "";
  if (!reply) fail("reply 不能为空：对本人说一两句");
  if (answer.change === "none") return { reply, change: "none" };
  if (answer.change === "revise") {
    if (context.kind !== "grown") fail("只有生长的工作流用 revise；自动化用 automation 给出整个 plan");
    const revision = typeof answer.revision === "string" ? answer.revision.trim() : "";
    if (revision.length < 6) fail("revise 须在 revision 写明要改什么");
    return { reply, change: "revise", revision };
  }
  if (answer.change !== "automation") return fail("change 只能是 none、automation 或 revise");
  if (context.kind !== "automation") fail("生长的工作流的文件不由这里改：用 revise 写明要改什么");
  const plan = validateAutomationPlan(answer.plan, context.lineIds, context.workflowId ? [context.workflowId] : []);
  // The conversation is about this one workflow: a change is always to it (or, while it is being made, a new one).
  return { reply, change: "automation", plan: { ...plan, replaces: context.workflowId } };
}
/* i18n-ignore-end */
