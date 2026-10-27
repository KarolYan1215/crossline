import "server-only";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createReminderWorkflow, requestAutomation, reviewAgentTask } from "@crossline/db";
import { ACTIONS, describeEvent, scheduleLabel, templateCriterion, windowDays, type AccessContext, type ActionArgs, type ActionId, type ProposedAction } from "@crossline/core";
import type { EvidenceClaimInput } from "@crossline/db";
import { addCapturedTaskWithId, approveWorkOrderProposal, archiveWorkOrder, completeWorkOrderExecution, getStore, saveMilestoneTemplate,
  shiftToday, startWorkOrderExecution } from "./crossline";
import { saveSourceFiles } from "./sources";
import { requestStepReplan, requestTaskPass } from "./steps";
import { approveMilestoneDrafts, rejectMilestoneDrafts } from "./approvals";
import { answerAsk, snoozeAsk } from "./asks";
import { analyzeNewCapturesInBackground } from "./capture-followups";
import { requestCodexSupervisor } from "./codex-runtime";
import { scheduleEvent } from "./event-scheduling";
import { applyChange } from "./impact";
import { createMilestoneDraft } from "./input";
import { addLine, identityLines, lineLabels, updateLine } from "./lines";
import { addDomainRecord, personToday } from "./records";
import { addReminder, createErrand } from "./life";
import { setPlaceMinutes, setTravel } from "./travel";
import { applyTaskOp, recordEnergy } from "./task-ops";
import { undoOp, withUndo } from "./undo";

/** What carrying out one action did: `message` is shown on the card; `opId` is what the card's 撤销 takes back. */
export type ActionOutcome = { ok: true; message: string; opId?: string; href?: string; captureId?: string } | { ok: false; message: string };

/** `captureId`: the capture a task.create wrote, so its card can say later what became of it (`captureProgress`). */
type Done = { ok: true; message?: string; href?: string; captureId?: string } | { ok: false; code: string; message?: string };
type Handler<K extends ActionId> = (ctx: AccessContext, args: ActionArgs<K>) => Done | Promise<Done>;

/**
 * Every action of the registry (`packages/core/src/concierge.ts`), carried out through the same function its page uses. The input box,
 * a nudge's buttons and the pages therefore share one path per change. The record is checked to be complete by the type and by
 * `actions.test.ts`.
 */
export const ACTION_HANDLERS: { [K in ActionId]: Handler<K> } = {
  "task.create": (ctx, args) => {
    const labels = lineLabels(ctx);
    const milestone = args.milestoneId ? getStore().listMilestones(ctx.workspaceId).find((item) => item.id === args.milestoneId) : undefined;
    // The light card's fields reach the analysis as context; it still decides the line, the estimate and the steps.
    const hints = [args.lineId ? `主线：${labels[args.lineId] ?? args.lineId}` : "", args.dueDate ? `截止：${args.dueDate}` : "",
      milestone ? `关联里程碑：${milestone.title}` : ""].filter(Boolean).join("；");
    const id = randomUUID();
    addCapturedTaskWithId(ctx, { title: args.title.trim().slice(0, 240), context: [args.context.trim(), hints].filter(Boolean).join("\n").slice(0, 500) }, id, id);
    analyzeNewCapturesInBackground(ctx);
    // No approved milestone is needed any more: the analysis files the task under its line unbound, so a new account's first task is
    // analysed and scheduled on its first day.
    return { ok: true, message: "已收集，正在分析估时与步骤", href: "/workbench", captureId: id };
  },
  // The note is the conversation's own message, searchable from the box; nothing else is written.
  "note.add": () => ({ ok: true, message: "已记下，可在对话记录中搜索" }),
  "task.op": async (ctx, args) => {
    const result = await applyTaskOp(ctx, args.workOrderId, { ...args, summary: "" });
    return result.ok ? { ok: true, href: `/workbench/${encodeURIComponent(args.workOrderId)}` } : result;
  },
  "ask.answer": async (ctx, args) => answerAsk(ctx, args.askId, args.optionId, Object.fromEntries(args.fields.map((field) => [field.id, field.value]))),
  "ask.snooze": (ctx, args) => snoozeAsk(ctx, args.askId, args.until),
  "undo": (ctx, args) => {
    const result = undoOp(ctx, args.opId);
    return result.ok ? { ok: true, message: `已撤销：${result.label}` } : result;
  },
  "energy.report": (ctx, args) => recordEnergy(ctx, args.level, args.note),
  "record.add": (ctx, args) => {
    const result = addDomainRecord(ctx, { domain: args.domain, kind: args.kind, value: args.value, unit: args.unit, currency: args.domain === "wealth" ? args.currency || "CNY" : "",
      category: args.category, note: args.note, at: args.at || personToday(ctx), source: "input", sourceRef: "" });
    return result.ok ? { ok: true, message: "已记下" } : { ok: false, code: result.code, message: result.message };
  },
  // 「后面都推 10 分钟」: today's plan starts later; started and locked blocks stay. Undone like any `schedule.` setting.
  "schedule.shift": (ctx, args) => {
    const result = shiftToday(ctx, args.minutes);
    return result.ok ? { ok: true, message: result.message, href: "/" } : result;
  },
  "availability.set": (ctx, args) => {
    const windows = args.windows.map((window) => ({ days: windowDays(window.days), start: window.start, end: window.end, energy: window.energy }));
    const result = applyChange(ctx, { kind: "availability", windows });
    if (!result.ok) return result;
    const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    const hours = windows.reduce((sum, window) => sum + window.days.length * (minutes(window.end) - minutes(window.start)), 0) / 60;
    return { ok: true, href: "/plan", message: `每周可用时段改为约 ${Math.round(hours)} 小时` };
  },
  "event.create": async (ctx, args) => {
    const result = await scheduleEvent(ctx, { title: args.title, lineId: args.lineId, date: args.date, weekdays: args.weekdays, startTime: args.startTime,
      endTime: args.endTime, until: args.until, minutes: args.minutes > 0 ? args.minutes : 60, location: args.location });
    if (!result.ok) return { ok: false, code: result.code, message: result.message };
    return { ok: true, href: "/plan", message: `${describeEvent(result.event)}${result.placedBySystem ? "（系统选定的空档）" : ""}${result.moved ? ` · 重排了 ${result.moved} 个冲突的任务块` : ""}` };
  },
  "reminder.add": (ctx, args) => {
    const reminder = addReminder(ctx, { text: args.text.trim(), date: args.date, time: args.time });
    return { ok: true, message: `${reminder.date === personToday(ctx) ? "今天" : reminder.date.slice(5).replace("-", "/")} ${reminder.time} 在右上角提醒：${reminder.text}` };
  },
  "errand.prepare": (ctx, args) => {
    const result = createErrand(ctx, args);
    return result.ok ? { ok: true, message: result.message } : { ok: false, code: result.code, message: result.message };
  },
  "travel.set": (ctx, args) => {
    const patch = { ...(args.home.trim() ? { home: args.home } : {}), ...(args.work.trim() ? { work: args.work } : {}),
      ...(args.defaultMinutes > 0 ? { defaultMinutes: args.defaultMinutes } : {}), ...(args.useMap ? { useMap: args.useMap === "on" } : {}) };
    const settings = Object.keys(patch).length ? setTravel(ctx, patch) : undefined;
    if (args.place.trim()) setPlaceMinutes(ctx, args.place, args.minutes > 0 ? args.minutes : "online");
    const parts = [args.place.trim() ? `去「${args.place.trim()}」${args.minutes > 0 ? `约 ${Math.round(args.minutes)} 分钟` : "按线上（不留路上时间）"}` : "",
      args.home.trim() ? "已记下住址" : "", args.work.trim() ? "已记下工作或学习地点" : "", args.defaultMinutes > 0 ? `默认通勤 ${Math.round(args.defaultMinutes)} 分钟` : "",
      settings?.home && settings.useMap ? "有地点的日程按 OpenStreetMap 估算路上时间（住址与地点会发给 OpenStreetMap）" : ""].filter(Boolean);
    return { ok: true, message: parts.join("；"), href: "/settings#travel" };
  },
  "goal.add": (ctx, args) => {
    const line = identityLines(ctx).find((pack) => pack.id === args.lineId);
    if (!line) return { ok: false, code: "LINE_NOT_FOUND" };
    const goals = line.goals ?? [];
    return goals.includes(args.title) ? { ok: true, message: "这个长期目标已在" } : { ...updateLine(ctx, args.lineId, { goals: [...goals, args.title] }), href: "/milestones" };
  },
  "milestone.draft": (ctx, args) => {
    const result = createMilestoneDraft(ctx, { lineId: args.lineId, title: args.title, date: args.date, target: args.target });
    return result.ok ? { ok: true, message: "草稿已建立，在主线页批准", href: `/milestones?open=${encodeURIComponent(result.id)}` } : result;
  },
  "line.add": (ctx, args) => {
    const result = addLine(ctx, { label: args.label, goal: "", ...(args.domain ? { domain: args.domain } : {}) });
    if (!result.ok && result.code === "LINE_DOMAIN_TAKEN") {
      // One live line per domain: say which line has it, so the person can change that one instead of adding a second.
      return { ok: false, code: result.code, message: `「${lineLabels(ctx)[result.lineId ?? ""] ?? "另一条主线"}」已经负责这个领域，可在主线页修改那条主线` };
    }
    return result.ok ? { ok: true, message: "这条主线的访谈可以开始了", href: `/onboarding?line=${encodeURIComponent(result.id)}` } : result;
  },
  "profile.tell": (ctx, args) => {
    // About one line (said on its card or page): that line's own interview, the same session its card and /onboarding?line= use.
    const line = args.lineId ? identityLines(ctx).find((pack) => pack.id === args.lineId) : undefined;
    if (args.lineId && !line) return { ok: false, code: "LINE_NOT_FOUND" };
    const session = line ? { id: `line-${line.id}` } : getStore().getLatestOnboardingSession(ctx.workspaceId);
    if (!session) return { ok: false, code: "INTERVIEW_NOT_STARTED", message: "还没有访谈，先在画像页开始访谈" };
    // The interview takes it as the person's reply, with its own instructions and everything it knows of them.
    void requestCodexSupervisor(ctx, "/v1/onboarding/turn", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, text: args.text }), signal: AbortSignal.timeout(3 * 60 * 60_000) }).catch(() => undefined);
    return line ? { ok: true, message: `已交给「${line.label}」的访谈，主线卡片随后更新`, href: `/milestones?line=${encodeURIComponent(line.id)}` }
      : { ok: true, message: "已交给访谈，画像随后更新", href: "/onboarding" };
  },
  "workflow.request": (ctx, args) => {
    // The assistant grows it into a workflow on the worker's next pass (docs/skills-library.md §6) and says so when it is ready.
    const line = args.lineId ? identityLines(ctx).find((pack) => pack.id === args.lineId) : undefined;
    if (args.lineId && !line) return { ok: false, code: "LINE_NOT_FOUND" };
    // A plain reminder needs no method written down: it is set at once and said at its time (desktop and phone when no page is open).
    if (args.reminder.trim() && args.time) {
      const record = createReminderWorkflow(getStore(), ctx.workspaceId,
        { text: args.text, reminder: args.reminder.trim(), time: args.time, weekdays: args.weekdays, lineId: line?.id ?? "" });
      return { ok: true, message: `已设好：${scheduleLabel(record.manifest.schedule)}提醒「${args.reminder.trim()}」`, href: "/settings#skills" };
    }
    // No line, no guess: the first line is not a default (a media request filed under research was grown in research's way).
    const target = line;
    if (!target) return { ok: false, code: "LINE_REQUIRED", message: "请说明这件事服务哪条主线" };
    // An automation for every account (docs/personal-agent.md, 2026-10-19): the worker designs it from the words now — a trigger it
    // watches and what the assistant does each time — and says when it is ready. A worker that is down takes it up when it is back.
    requestAutomation(getStore(), ctx.workspaceId, args.text, target.id, ctx.principalId);
    void requestCodexSupervisor(ctx, "/v1/automations/design", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }).catch(() => undefined);
    return { ok: true, message: "已交给助手建成自动化，建好后会通知，并说明它按什么条件运行；发出、发布一类的步骤仍由本人完成", href: "/settings#automation" };
  },
  "proposal.decide": (ctx, args) => {
    if (args.decision !== "approve") return archiveWorkOrder(ctx, args.workOrderId, args.reason.trim() || "在输入框中拒绝");
    const result = approveWorkOrderProposal(ctx, args.workOrderId);
    if (result.ok) requestTaskPass(ctx);
    return result;
  },
  "milestones.decide": (ctx, args) => {
    const result = (args.decision === "approve" ? approveMilestoneDrafts : rejectMilestoneDrafts)(ctx, args.milestoneIds);
    if (!result.approved.length) return { ok: false, code: result.skipped[0]?.code ?? "MILESTONE_NOT_DRAFT" };
    return { ok: true, message: `${args.decision === "approve" ? "已批准" : "已撤下"} ${result.approved.length} 个${result.skipped.length ? `，${result.skipped.length} 个未处理` : ""}`, href: "/milestones" };
  },
  "agent_result.review": (ctx, args) => {
    const result = reviewAgentTask(getStore(), ctx.workspaceId, args.taskId, args.decision, args.note);
    return result.ok ? { ok: true } : { ok: false, code: result.code };
  },
  "importance.set": (ctx, args) => applyChange(ctx, { kind: "weight", milestoneId: args.milestoneId, weight: Math.round(args.weight) }),

  // A syllabus or schedule: the interview reads its dates (the one place that reads them), and they come back as a batch to confirm.
  "dates.read": (ctx, args) => {
    const doc = findDoc(ctx, args.documentId);
    if (!doc) return { ok: false, code: "DOCUMENT_NOT_FOUND" };
    if (args.projectId && doc.projectId !== args.projectId) fileUnder(ctx, doc.id, args.projectId);
    const session = getStore().getLatestOnboardingSession(ctx.workspaceId);
    if (!session) return { ok: false, code: "INTERVIEW_NOT_STARTED", message: "还没有访谈；先在画像页开始访谈，日期由访谈读取" };
    void requestCodexSupervisor(ctx, "/v1/onboarding/turn", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: session.id, text: `我在输入框添加了文件《${doc.fileName}》。请只整理其中的日期（上课、作业、测验、考试、项目）。` }),
      signal: AbortSignal.timeout(3 * 60 * 60_000) }).catch(() => undefined);
    return { ok: true, message: "已交给访谈读取日期，几分钟后在「待确认 · 文件中的日期」确认", href: "/approvals" };
  },
  "material.file": (ctx, args) => {
    if (!findDoc(ctx, args.documentId)) return { ok: false, code: "DOCUMENT_NOT_FOUND" };
    fileUnder(ctx, args.documentId, args.projectId);
    return { ok: true, message: "已归入项目；该项目的任务会读到它" };
  },
  // Material for a task: filed under the task's project (which is how plans and the assistant find a task's files) and the steps
  // re-planned against it, because a plan rests on the person's own material.
  "material.attach": (ctx, args) => {
    const store = getStore();
    const doc = findDoc(ctx, args.documentId);
    const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === args.workOrderId);
    if (!doc || !order) return { ok: false, code: doc ? "WORK_ORDER_NOT_FOUND" : "DOCUMENT_NOT_FOUND" };
    if (order.projectId && doc.projectId !== order.projectId) fileUnder(ctx, doc.id, order.projectId);
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `task.note:${order.id}:${randomUUID()}`, type: "task.note",
      entityId: order.id, payload: { text: `添加材料《${doc.fileName}》`, kind: "material", documentId: doc.id } });
    if (store.getStepPlan(ctx.workspaceId, order.id)) requestStepReplan(ctx, order.id, `新增材料《${doc.fileName}》，按其内容核对并调整步骤`);
    return { ok: true, message: "已挂到任务，步骤将按新材料重新安排", href: `/workbench/${encodeURIComponent(order.id)}` };
  },
  // A finished piece handed in: the task is started if it was not, and completed with the files as its evidence. A PDF or Word file is
  // handed in with its text beside it, because the gate can quote only text.
  "evidence.submit": (ctx, args) => {
    const store = getStore();
    const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === args.workOrderId);
    if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
    const evidence: EvidenceClaimInput[] = [];
    for (const id of args.documentIds) {
      const doc = findDoc(ctx, id);
      if (!doc) return { ok: false, code: "DOCUMENT_NOT_FOUND" };
      evidence.push({ kind: "file", uri: doc.uri, description: doc.fileName.slice(0, 500) });
      if ((doc.kind === "pdf" || doc.kind === "docx") && doc.extractionStatus === "done" && doc.extractedText.trim()) {
        const text = `${fileURLToPath(doc.uri).replace(/\.[a-z]+$/i, "")}.extracted.txt`;
        writeFileSync(text, doc.extractedText, "utf8");
        evidence.push({ kind: "file", uri: pathToFileURL(text).href, description: `${doc.fileName}（文本）`.slice(0, 500) });
      }
    }
    if (args.note.trim()) evidence.push({ kind: "record", uri: `note:${order.id}`, description: args.note.trim().slice(0, 500) });
    if (["approved", "preparing", "ready_for_human"].includes(order.state)) {
      const started = startWorkOrderExecution(ctx, order.id);
      if (!started.ok) return started;
    }
    const done = completeWorkOrderExecution(ctx, order.id, evidence);
    return done.ok ? { ok: true, message: "已提交，等待验收", href: `/workbench/${encodeURIComponent(order.id)}` } : done;
  },
  // A file the box wrote for a task (a script, a table, notes): kept as one of the person's materials under the task's project.
  "material.save": (ctx, args) => {
    const order = getStore().listWorkOrders(ctx.workspaceId).find((item) => item.id === args.workOrderId);
    if (!order) return { ok: false, code: "WORK_ORDER_NOT_FOUND" };
    const saved = saveSourceFiles(ctx, [{ fileName: args.fileName, mediaType: "text/plain", buffer: Buffer.from(args.content, "utf8") }], order.projectId || undefined);
    if (!saved.ok) return { ok: false, code: saved.code, message: saved.message };
    const doc = saved.documents[0]!;
    getStore().setSourceDocumentExtraction(ctx.workspaceId, doc.id, { status: "done", text: args.content });
    return { ok: true, message: `已保存为《${args.fileName}》`, href: `/api/source-documents/${encodeURIComponent(doc.id)}/file` };
  },
  "template.add": (ctx, args) => {
    const criteria = args.criteria.map(templateCriterion);
    if (criteria.some((item) => !item)) return { ok: false, code: "TEMPLATE_CRITERIA_INCOMPLETE", message: "有标准缺少衡量方式（单位、数值、产出物或判定规则）" };
    const result = saveMilestoneTemplate(ctx, { identityId: args.lineId, kind: args.kind, titleHint: args.titleHint,
      successCriteriaDefaults: criteria as NonNullable<(typeof criteria)[number]>[] });
    return result.ok ? { ok: true, message: "模板已添加，新建里程碑时可选", href: "/milestones" } : result;
  }
};

const findDoc = (ctx: AccessContext, id: string) => getStore().listSourceDocuments(ctx.workspaceId).find((doc) => doc.id === id);

/** Files a document under a project the way 待决事项 does, with the same record (it can be undone). */
function fileUnder(ctx: AccessContext, documentId: string, projectId: string): void {
  const store = getStore();
  store.assignSourceDocumentProject(ctx.workspaceId, documentId, projectId);
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `source:assigned:${documentId}:${projectId}:${Date.now()}`,
    type: "source.project_assigned", entityId: documentId, payload: { projectId, by: "person" } });
}

/** Words for the codes a handler can return, so a failed card says why in the person's terms. */
const FAILURE: Record<string, string> = {
  WORK_ORDER_NOT_FOUND: "任务已不存在", ASK_NOT_FOUND: "这件待决事项已处理或已过期", OP_NOT_UNDOABLE: "该操作已撤销或超过 24 小时",
  MILESTONE_NOT_DRAFT: "里程碑已不是草稿", LINE_NOT_FOUND: "主线不存在", TASK_NOT_FOUND: "助手任务不存在", PROPOSAL_VERSION_CHANGED: "任务已被改动，请刷新后重试",
  DOCUMENT_NOT_FOUND: "文件不存在", SHIFT_MINUTES_INVALID: "顺延须在 5–120 分钟之间", EXECUTION_NOT_ACTIVE: "任务当前不能提交", TEMPLATE_IDENTITY_UNKNOWN: "主线不存在", SOURCE_TYPE_NOT_ALLOWED: "不支持的文件类型"
};

/** Carries out one confirmed action. Everything except an undo is recorded for 撤销; a failure changes nothing and says why. */
export async function executeAction(ctx: AccessContext, item: ProposedAction): Promise<ActionOutcome> {
  const handler = ACTION_HANDLERS[item.action] as Handler<ActionId>;
  const label = `${ACTIONS[item.action].label}：${item.summary || ""}`.slice(0, 160);
  try {
    const result = item.action === "undo" ? await handler(ctx, item.args) : await withUndo(ctx, label, () => handler(ctx, item.args));
    if (!result.ok) return { ok: false, message: result.message ?? FAILURE[result.code] ?? `未完成（${result.code}）` };
    const op = "op" in result ? (result as { op?: { id: string } }).op : undefined;
    return { ok: true, message: result.message ?? "已完成", ...(op ? { opId: op.id } : {}), ...(result.href ? { href: result.href } : {}),
      ...(result.captureId ? { captureId: result.captureId } : {}) };
  } catch (error) {
    return { ok: false, message: error instanceof Error && FAILURE[error.message] ? FAILURE[error.message]! : "未完成，请重试" };
  }
}
