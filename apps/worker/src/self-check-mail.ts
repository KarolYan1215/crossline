import { existsSync } from "node:fs";
import path from "node:path";
import {
  AUTOMATION_RUNS_SETTING, AUTOMATIONS_SETTING, MAIL_ACCOUNTS_SETTING, MAIL_REPLIES_SETTING, readAutomationRuns, readAutomations, readMailAccounts,
  workflowDue, zonedParts
} from "@crossline/core";
import { openReplyDrafts, readReplyDrafts, zoneOfWorkspace, type CrosslineStore } from "@crossline/db";
import { pendingRequests, queue, saveQueue } from "./automations";
import { mailDraftsDir } from "./mail-replies";
import { REPLY_FAILURES_MAX, REPLY_QUEUE_SETTING, replyQueueOf } from "./mailbox";
import { tOfWorkspace } from "./locale";
import type { Probe, ProbeOutcome } from "./self-check";

type Finding = { code: string; detail: string };
/** Several findings as one outcome: anything still wrong fails (its first code), else anything put right is `repaired`. */
function outcomeOf(failing: Finding[], repaired: Finding[]): ProbeOutcome {
  const pick = failing.length ? failing : repaired;
  if (!pick.length) return { status: "ok", code: "", detail: "" };
  return { status: failing.length ? "failing" : "repaired", code: pick[0]!.code, detail: [...failing, ...repaired].map((item) => item.detail).join("；") };
}
const minutes = (now: Date, at: string | undefined) => at ? Math.round((now.getTime() - Date.parse(at)) / 60_000) : Number.POSITIVE_INFINITY;

/** Mail is read every 15 minutes; one not read for twice that is stuck. */
const MAIL_STALE_MINUTES = 30;

/**
 * 邮箱与回信草稿: each mailbox read lately and without a refusal, every reply draft the ledger names has its file, the reply queue holds
 * nothing it has already given up on, drafts are not left untold because notifications are off, and the person's answers can be found
 * (a sent folder exists). `dataDir` is where drafts are written; without it the file check is skipped. No network call: the sent folder
 * is known from the last follow-up (`noSentFolder`).
 */
export function mailProbe(store: CrosslineStore, dataDir?: string): Probe {
  return { id: "mail", run: (workspaceId, now) => {
    const accounts = readMailAccounts(store.getSetting(workspaceId, MAIL_ACCOUNTS_SETTING));
    if (!accounts.length) return { status: "skipped", code: "", detail: "" };
    const t = tOfWorkspace(store, workspaceId);
    const failing: Finding[] = [], repaired: Finding[] = [];
    for (const account of accounts) {
      const label = account.label || account.address;
      if (account.lastError) failing.push({ code: account.lastError.code || "MAIL_READ_FAILED",
        detail: t("邮箱「{{label}}」读不了：{{message}}", { label, message: account.lastError.message }) });
      else if (minutes(now, account.lastCheckedAt ?? account.addedAt) > MAIL_STALE_MINUTES) failing.push({ code: "MAIL_CHECK_STALE",
        detail: t("邮箱「{{label}}」已经 {{count}} 分钟没有读取新邮件", { label, count: Math.min(minutes(now, account.lastCheckedAt ?? account.addedAt), 99_999) }) });
      if (account.noSentFolder) failing.push({ code: "MAIL_SENT_FOLDER_MISSING",
        detail: t("邮箱「{{label}}」找不到「已发送」文件夹，本人回过的邮件不会自动关掉草稿", { label }) });
    }
    if (dataDir) {
      const drafts = readReplyDrafts(store, workspaceId);
      const dir = mailDraftsDir(dataDir, workspaceId);
      const kept = drafts.filter((draft) => existsSync(path.join(dir, draft.file)));
      if (kept.length < drafts.length) {
        store.setSetting(workspaceId, MAIL_REPLIES_SETTING, JSON.stringify(kept));
        repaired.push({ code: "MAIL_DRAFT_FILE_MISSING", detail: t("{{count}} 份回信草稿的文件已不在，已去掉它们的记录", { count: drafts.length - kept.length }) });
      }
    }
    const queued = replyQueueOf(store, workspaceId);
    const live = queued.filter((item) => (item.failures ?? 0) < REPLY_FAILURES_MAX);
    if (live.length < queued.length) {
      store.setSetting(workspaceId, REPLY_QUEUE_SETTING, JSON.stringify(live));
      repaired.push({ code: "MAIL_REPLY_QUEUE_STUCK", detail: t("{{count}} 封起草两次都没成功的邮件已不再重试", { count: queued.length - live.length }) });
    }
    if (store.getSetting(workspaceId, "notify.level") === "off") {
      const untold = openReplyDrafts(store, workspaceId).filter((draft) => !draft.notifiedAt && minutes(now, draft.createdAt) > 24 * 60);
      if (untold.length) failing.push({ code: "NOTIFY_OFF_DRAFTS_UNTOLD",
        detail: t("通知已关闭，{{count}} 份回信草稿超过一天没有告诉本人；在设置里打开通知，或到邮箱卡片里查看", { count: untold.length }) });
    }
    return outcomeOf(failing, repaired);
  } };
}

/** A schedule more than this late with no run is missed (the pass runs every tick). */
const SCHEDULE_LATE_MINUTES = 30;
const QUEUE_MAX_MS = 2 * 3_600_000;
const DESIGN_STUCK_MS = 3_600_000;

/**
 * 自动化: schedules that passed today without a run, firings queued for over two hours (dropped), watched pages that are not being read,
 * and requests the designer never took up. No model call; the thread is not checked (a lost one is already replaced at its next run).
 */
export function automationsProbe(store: CrosslineStore): Probe {
  return { id: "automations", run: (workspaceId, now) => {
    const automations = readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING));
    const pending = pendingRequests(store, workspaceId);
    const waiting = queue(store, workspaceId);
    if (!automations.length && !pending.length && !waiting.length) return { status: "skipped", code: "", detail: "" };
    const t = tOfWorkspace(store, workspaceId);
    const zone = zoneOfWorkspace(store, workspaceId);
    const failing: Finding[] = [], repaired: Finding[] = [];
    const { day, clock } = zonedParts(now, zone);
    const runs = readAutomationRuns(store.getSetting(workspaceId, AUTOMATION_RUNS_SETTING));
    const toMinutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    for (const automation of automations.filter((item) => item.status === "active")) {
      const { trigger } = automation;
      if (trigger.type === "schedule") {
        const late = toMinutes(clock) - toMinutes(trigger.schedule.time);
        // Due today however late (`heldSince` today), and no firing of any kind noted today.
        if (late > SCHEDULE_LATE_MINUTES && workflowDue(trigger.schedule, automation.lastFiredAt, now, zone, now.toISOString())
          && Date.parse(automation.updatedAt) < now.getTime() - late * 60_000
          && !runs.some((run) => run.automationId === automation.id && zonedParts(new Date(run.firedAt), zone).day === day)) {
          failing.push({ code: "AUTOMATION_SCHEDULE_MISSED", detail: t("自动化「{{name}}」今天 {{time}} 该运行，到现在还没有运行", { name: automation.name, time: trigger.schedule.time }) });
        }
      } else if (trigger.type === "watch") {
        const stale = now.getTime() - Date.parse(automation.watch?.checkedAt ?? automation.updatedAt) > 2 * trigger.hours * 3_600_000;
        if (automation.watch?.lastError || stale) failing.push({ code: "AUTOMATION_WATCH_FAILING", detail: automation.watch?.lastError
          ? t("自动化「{{name}}」读不了要看的网页：{{reason}}", { name: automation.name, reason: automation.watch?.lastError ?? "" })
          : t("自动化「{{name}}」已经超过 {{count}} 小时没有读要看的网页", { name: automation.name, count: 2 * trigger.hours }) });
      }
    }
    const fresh = waiting.filter((item) => now.getTime() - Date.parse(item.at) <= QUEUE_MAX_MS);
    if (fresh.length < waiting.length) {
      saveQueue(store, workspaceId, fresh);
      repaired.push({ code: "AUTOMATION_QUEUE_STALE", detail: t("{{count}} 次等待超过两小时的自动化运行已取消", { count: waiting.length - fresh.length }) });
    }
    const stuck = pending.filter((event) => now.getTime() - Date.parse(event.createdAt) > DESIGN_STUCK_MS);
    if (stuck.length) failing.push({ code: "AUTOMATION_DESIGN_STUCK",
      detail: t("「{{text}}」交给助手设计已超过一小时，还没有建成", { text: String((stuck[0]!.payload as { text?: string }).text ?? "").slice(0, 40) }) });
    return outcomeOf(failing, repaired);
  } };
}
