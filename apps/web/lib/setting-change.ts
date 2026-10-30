import "server-only";
import { categoryMode, chosenLocale, isAutoHandoff, isPaused, readCategories, setAutoHandoff, setCategoryMode, setPaused, writeLocale } from "@crossline/db";
import {
  AGENT_CATEGORIES, AGENT_HISTORY_CONSENT, BACKGROUND_KINDS, BACKGROUND_PAUSED, CAMERA_ENERGY_CONSENT, FAMILIARITY_SETTING, INPUT_RHYTHM_CONSENT, MAIL_ACCOUNTS_SETTING,
  MAIL_REPLY_DRAFTS_SETTING, QUOTA_SAVER_SETTING, RECORDING_CONSENT, RECORDING_SERVER_CONSENT, RECORDING_VOICEPRINT_CONSENT, SETTING_CATALOG, SLEEP_TRACKING_CONSENT,
  TELEMETRY_ENABLED_SETTING, AUTOMATIONS_SETTING, completionRule, familiarityKey, parseShares, parseSlot, pausedKinds, quotaSaverOn, readAutomations, readMailAccounts,
  replyDraftsOn, type AccessContext, type AgentCategory, type BackgroundKind, type SettingEntry, type SettingKey, type SettingValueSpec
} from "@crossline/core";
import { normalizeParams, paramsFor, PARAMS_ASAP, PARAMS_BUFFERED, type ScheduleParams } from "@crossline/planner";
import { setAutostart, autostartAvailable } from "./autostart";
import { setBackgroundPaused, setQuotaSaver } from "./background";
import { requestCodexSupervisor } from "./codex-runtime";
import { SCREEN_LEVEL_CHANGE, dismissEnergyAdvice, screenLevel, setActivityConsent, setAgentHistory, setEnergySignal, setNotifyLevel, setRecordings, setServerRecordings,
  setSleepTracking, setTelemetry, setVoiceprint, type ScreenLevel } from "./consents";
import { appNow, effectiveSchedulePreferences, getStore, loadCurrentPlan, lockBlock, milestoneDeadline, readFrozen, readLineShares, saveGoalSettings, saveMilestoneEdit,
  setCompletionMode, unlockBlock } from "./crossline";
import { phoneHealthOn } from "./energy";
import { setFamiliarity } from "./familiarity";
import { applyChange, previewChange, type Change } from "./impact";
import { lineLabels } from "./lines";
import { localeFor, tOf } from "./locale";
import { saveDraftSettings } from "./milestone-board";
import { permissionModeEnabled, setPermissionMode } from "./permission-mode";
import { ARCHETYPE_CURATION_PERIOD } from "./preferences";
import { setReplyDrafts } from "./mail-drafts";
import { LOCALE_COOKIE } from "./i18n";

/**
 * `setting.change` carried out (docs/one-input.md 「设置」): for each key of the catalog in core, how its current value is read and the
 * function its settings card or route calls to change it — the same function, never a write of its own. Keys that move the schedule
 * (`impact`) go through `lib/impact.ts`, as the plan page's controls do, and their card shows the preview.
 */
type Result = { ok: true; message?: string; href?: string } | { ok: false; code: string; message?: string };
type Handler = {
  current: (ctx: AccessContext, target: string) => string | undefined | Promise<string | undefined>;
  apply: (ctx: AccessContext, target: string, value: string) => Result | Promise<Result>;
  /** The schedule change to preview on the card (and apply through `applyChange`). */
  impact?: (ctx: AccessContext, target: string, value: string) => Change | undefined | Promise<Change | undefined>;
};

const store = () => getStore();
const flag = (on: boolean) => on ? "on" : "off";
const ok = (): Result => ({ ok: true });
const setting = (ctx: AccessContext, key: string) => store().getSetting(ctx.workspaceId, key);
const params = (ctx: AccessContext): ScheduleParams => paramsFor(effectiveSchedulePreferences(ctx).preferences);
const withParam = (key: keyof ScheduleParams): Handler => ({
  current: (ctx) => String(key === "maxDailyShare" ? Math.round(params(ctx)[key] * 100) : params(ctx)[key]),
  impact: (ctx, _target, value) => ({ kind: "params", params: normalizeParams({ ...params(ctx), [key]: key === "maxDailyShare" ? Number(value) / 100 : Number(value) }) }),
  apply: (ctx, target, value) => applyImpact(ctx, withParam(key), target, value)
});
async function applyImpact(ctx: AccessContext, handler: Handler, target: string, value: string): Promise<Result> {
  const change = await handler.impact!(ctx, target, value);
  return change ? applyChange(ctx, change) : { ok: false, code: "SETTING_TARGET_NOT_FOUND" };
}
const switched = (result: { ok: true } | { ok: false; code: string }): Result => result;
/** A mailbox switch, through the worker that holds the mailbox (the settings card's route proxies the same path). */
const mailSwitch = (path: "triage" | "bookkeeping", field: "triage" | "bookkeeping"): Handler => ({
  current: (ctx, target) => { const account = readMailAccounts(setting(ctx, MAIL_ACCOUNTS_SETTING)).find((item) => item.id === target);
    return account ? flag(field === "triage" ? account.triage : account.bookkeeping !== false) : undefined; },
  apply: async (ctx, target, value) => worker(ctx, `/v1/mail/accounts/${encodeURIComponent(target)}/${path}`, { on: value === "on" })
});
async function worker(ctx: AccessContext, path: string, body: unknown): Promise<Result> {
  try {
    await requestCodexSupervisor(ctx, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    return { ok: true };
  } catch { return { ok: false, code: "WORKER_UNAVAILABLE", message: tOf(ctx)("后台服务没有连上，稍后再试。") }; }
}
const recordingValue = (on: boolean) => on ? "on" : "off_keep";
const blockOf = async (ctx: AccessContext, blockId: string) => (await loadCurrentPlan(ctx)).blocks.find((block) => block.id === blockId && block.day);

export const SETTING_HANDLERS: Record<SettingKey, Handler> = {
  "schedule.lineShares": {
    current: (ctx) => Object.entries(readLineShares(ctx) ?? {}).map(([line, share]) => `${line}=${share}`).join(","),
    impact: (_ctx, _target, value) => ({ kind: "shares", shares: parseShares(value) ?? {} }),
    apply: (ctx, target, value) => applyImpact(ctx, SETTING_HANDLERS["schedule.lineShares"], target, value)
  },
  "schedule.preset": {
    current: (ctx) => { const now = JSON.stringify(params(ctx)); return now === JSON.stringify(PARAMS_ASAP) ? "asap" : now === JSON.stringify(PARAMS_BUFFERED) ? "buffered" : undefined; },
    impact: (_ctx, _target, value) => ({ kind: "params", params: value === "asap" ? PARAMS_ASAP : PARAMS_BUFFERED }),
    apply: (ctx, target, value) => applyImpact(ctx, SETTING_HANDLERS["schedule.preset"], target, value)
  },
  "schedule.gapMinutes": withParam("gapMinutes"),
  "schedule.maxDailyShare": withParam("maxDailyShare"),
  "schedule.focusCapMinutes": withParam("focusCapMinutes"),
  "schedule.deadlineBufferDays": withParam("deadlineBufferDays"),
  "notify.level": { current: (ctx) => setting(ctx, "notify.level") ?? "normal", apply: (ctx, _target, value) => setNotifyLevel(ctx, value) },
  "language": {
    current: (ctx) => chosenLocale(store(), ctx.workspaceId) ?? localeFor(ctx),
    apply: async (ctx, _target, value) => {
      const locale = value === "en" ? "en" : "zh";
      writeLocale(store(), ctx.workspaceId, locale);
      // This browser follows too, as the language card's route sets it; outside a request (the worker, a test) the account is enough.
      try { const { cookies } = await import("next/headers"); (await cookies()).set(LOCALE_COOKIE, locale, { path: "/", maxAge: 365 * 24 * 3600, sameSite: "lax", httpOnly: false }); }
      catch { /* not in a request */ }
      return { ok: true, href: "/settings#general" };
    }
  },
  "background.paused": {
    current: (ctx, target) => target === "assistant" ? (isPaused(store(), ctx.workspaceId) ? "paused" : "running")
      : pausedKinds(setting(ctx, BACKGROUND_PAUSED)).has(target as BackgroundKind) ? "paused" : "running",
    apply: (ctx, target, value) => setBackgroundPaused(ctx, target as BackgroundKind, value === "paused")
  },
  "background.quotaSaver": { current: (ctx) => flag(quotaSaverOn(setting(ctx, QUOTA_SAVER_SETTING))), apply: (ctx, _target, value) => setQuotaSaver(ctx, value === "on") },
  "agent.paused": { current: (ctx) => isPaused(store(), ctx.workspaceId) ? "paused" : "running",
    apply: (ctx, _target, value) => { setPaused(store(), ctx.workspaceId, value === "paused"); return ok(); } },
  "agent.autoHandoff": { current: (ctx) => flag(isAutoHandoff(store(), ctx.workspaceId)),
    apply: (ctx, _target, value) => { setAutoHandoff(store(), ctx.workspaceId, value === "on"); return ok(); } },
  "permission.mode": { current: (ctx) => flag(permissionModeEnabled(ctx)), apply: (ctx, _target, value) => { setPermissionMode(ctx, value === "on"); return ok(); } },
  "agent.category": {
    current: (ctx, target) => flag(categoryMode(readCategories(store(), ctx.workspaceId)[target as AgentCategory]) !== "off"),
    // 开启 is `auto`, as the settings card's on/off sends it (results accepted by default since 2026-10-15).
    apply: (ctx, target, value) => { setCategoryMode(store(), ctx.workspaceId, target as AgentCategory, value === "on" ? "auto" : "off"); return ok(); }
  },
  "automation.status": {
    current: (ctx, target) => readAutomations(setting(ctx, AUTOMATIONS_SETTING)).find((item) => item.id === target)?.status,
    apply: (ctx, target, value) => worker(ctx, `/v1/automations/${encodeURIComponent(target)}/status`, { status: value === "off" ? "off" : "active" })
  },
  "mail.triage": mailSwitch("triage", "triage"),
  "mail.bookkeeping": mailSwitch("bookkeeping", "bookkeeping"),
  "mail.replyDrafts": { current: (ctx) => flag(replyDraftsOn(setting(ctx, MAIL_REPLY_DRAFTS_SETTING))), apply: (ctx, _target, value) => { setReplyDrafts(ctx, value === "on"); return ok(); } },
  "archetypes.curationPeriod": { current: (ctx) => setting(ctx, ARCHETYPE_CURATION_PERIOD) ?? "biweekly",
    apply: (ctx, _target, value) => { store().setSetting(ctx.workspaceId, ARCHETYPE_CURATION_PERIOD, value); return ok(); } },
  "milestone.deadline": {
    current: (ctx, target) => milestoneDeadline(ctx, target),
    // As the milestone drawer does: an approved milestone's date is its goal setting, a draft's is the draft itself.
    apply: (ctx, target, value) => {
      const milestone = store().listMilestones(ctx.workspaceId).filter((item) => item.id === target).at(-1);
      if (!milestone) return { ok: false, code: "MILESTONE_NOT_FOUND" };
      const result = milestone.status === "draft" ? saveDraftSettings(ctx, target, { deadline: value }) : saveGoalSettings(ctx, target, { confirmedDeadline: value });
      return result.ok ? { ok: true, href: `/milestones?open=${encodeURIComponent(target)}` } : result;
    }
  },
  "milestone.title": {
    current: (ctx, target) => store().listMilestones(ctx.workspaceId).filter((item) => item.id === target).at(-1)?.title,
    apply: (ctx, target, value) => {
      const milestone = store().listMilestones(ctx.workspaceId).filter((item) => item.id === target).at(-1);
      if (!milestone) return { ok: false, code: "MILESTONE_NOT_FOUND" };
      const saved = saveMilestoneEdit(ctx, { id: target, identityId: milestone.identityId, projectId: milestone.projectId ?? "", title: value, status: milestone.status,
        successCriteria: milestone.successCriteria ?? [], ...(milestone.templateId ? { templateId: milestone.templateId } : {}) });
      return saved.ok ? { ok: true, href: `/milestones?open=${encodeURIComponent(target)}` } : saved;
    }
  },
  "task.completionMode": {
    current: (ctx, target) => { const order = store().getWorkOrder(ctx.workspaceId, target); return order ? completionRule(order).mode : undefined; },
    apply: (ctx, target, value) => switched(setCompletionMode(ctx, target, value as "self_evident" | "needs_assessment"))
  },
  "task.familiarity": {
    current: (ctx, target) => {
      const order = store().getWorkOrder(ctx.workspaceId, target);
      if (!order) return undefined;
      let map: Record<string, string> = {};
      try { map = JSON.parse(setting(ctx, FAMILIARITY_SETTING) ?? "{}") as Record<string, string>; } catch { map = {}; }
      return map[familiarityKey(order.identityId, store().getStepPlan(ctx.workspaceId, target)?.archetypeId)] ?? map[familiarityKey(order.identityId, undefined)] ?? "mid";
    },
    apply: (ctx, target, value) => setFamiliarity(ctx, target, value as "near" | "mid" | "far")
  },
  "energyAdvice.dismiss": { current: () => undefined, apply: (ctx) => dismissEnergyAdvice(ctx) },
  "block.lock": {
    current: (ctx, target) => readFrozen(ctx, appNow()).some((item) => item.blockId === target && (item.reason === "locked" || item.reason === "pinned")) ? "locked" : "unlocked",
    apply: async (ctx, target, value) => {
      if (value === "unlocked") return unlockBlock(ctx, target);
      const block = await blockOf(ctx, target);
      return block ? lockBlock(ctx, target, { day: block.day!, start: block.start, end: block.end }, "locked") : { ok: false, code: "SETTING_TARGET_NOT_FOUND" };
    }
  },
  "block.move": {
    current: async (ctx, target) => { const block = await blockOf(ctx, target); return block ? `${block.day} ${block.start}-${block.end}` : undefined; },
    impact: (_ctx, target, value) => {
      const slot = parseSlot(value);
      return slot ? { kind: "move_block", workOrderId: target.split(":")[1] ?? "", blockId: target, ...slot } : undefined;
    },
    apply: (ctx, target, value) => applyImpact(ctx, SETTING_HANDLERS["block.move"], target, value)
  },
  "autostart": {
    current: () => undefined,
    apply: async (_ctx, _target, value) => !autostartAvailable() ? { ok: false, code: "NOT_INSTALLED" } : await setAutostart(value === "on") ? ok() : { ok: false, code: "AUTOSTART_NOT_SAVED" }
  },
  "telemetry": { current: (ctx) => flag(setting(ctx, TELEMETRY_ENABLED_SETTING) !== "0"), apply: (ctx, _target, value) => setTelemetry(ctx, value === "on") },
  "consent.sleepTracking": { current: (ctx) => flag(setting(ctx, SLEEP_TRACKING_CONSENT) === "granted"), apply: (ctx, _target, value) => setSleepTracking(ctx, value === "on") },
  "consent.inputRhythm": { current: (ctx) => flag(setting(ctx, INPUT_RHYTHM_CONSENT) === "granted"), apply: (ctx, _target, value) => setEnergySignal(ctx, "input_rhythm", value === "on") },
  "consent.camera": { current: (ctx) => flag(setting(ctx, CAMERA_ENERGY_CONSENT) === "granted"), apply: (ctx, _target, value) => setEnergySignal(ctx, "camera", value === "on") },
  "consent.phoneHealth": { current: (ctx) => flag(phoneHealthOn(ctx.workspaceId)), apply: (ctx, _target, value) => setEnergySignal(ctx, "phone_health", value === "on") },
  "consent.screenActivity": { current: (ctx) => screenLevel(ctx), apply: (ctx, _target, value) => setActivityConsent(ctx, SCREEN_LEVEL_CHANGE[value as ScreenLevel]) },
  "consent.agentHistory": { current: (ctx) => flag(setting(ctx, AGENT_HISTORY_CONSENT) === "on"), apply: (ctx, _target, value) => setAgentHistory(ctx, value === "on") },
  "consent.recordings": { current: (ctx) => recordingValue(setting(ctx, RECORDING_CONSENT) === "granted"),
    apply: (ctx, _target, value) => setRecordings(ctx, value === "on", value !== "off_delete") },
  "consent.serverRecordings": { current: (ctx) => recordingValue(setting(ctx, RECORDING_SERVER_CONSENT) === "granted"),
    apply: (ctx, _target, value) => setServerRecordings(ctx, value === "on", value !== "off_delete") },
  "consent.voiceprint": { current: (ctx) => flag(setting(ctx, RECORDING_VOICEPRINT_CONSENT) === "granted"), apply: (ctx, _target, value) => setVoiceprint(ctx, value === "on") }
};

/** What the card shows for one change: the setting, 当前 → 改成 in words, what follows, and a consent's own explanation. */
export type SettingView = { label: string; from: string; to: string; consequence: string; explain?: string[] };

const readable = (ctx: AccessContext, spec: SettingValueSpec, raw: string | undefined): string => {
  const t = tOf(ctx);
  if (raw === undefined || raw === "") return t("未设置");
  if (spec.type === "enum") return spec.values[raw] ? t(spec.values[raw]!) : raw;
  if (spec.type === "number") return `${raw} ${t(spec.unit)}`;
  if (spec.type === "shares") {
    const labels = lineLabels(ctx);
    return Object.entries(parseShares(raw) ?? {}).map(([line, share]) => `${labels[line] ?? line} ${share}%`).join(t("、")) || t("按访谈所说");
  }
  return raw;
};

/** The words for the object a key is about (a task's or milestone's title, a mailbox's address). */
function targetName(ctx: AccessContext, entry: SettingEntry, target: string): string {
  const t = tOf(ctx);
  switch (entry.target) {
    case "milestone": return store().listMilestones(ctx.workspaceId).filter((item) => item.id === target).at(-1)?.title ?? target;
    case "task": return store().getWorkOrder(ctx.workspaceId, target)?.intent.slice(0, 40) ?? target;
    case "automation": return readAutomations(setting(ctx, AUTOMATIONS_SETTING)).find((item) => item.id === target)?.name ?? target;
    case "mailbox": return readMailAccounts(setting(ctx, MAIL_ACCOUNTS_SETTING)).find((item) => item.id === target)?.address ?? target;
    case "background": return t(BACKGROUND_KINDS.find((kind) => kind.kind === target)?.label ?? target);
    case "category": return t(AGENT_CATEGORIES[target as AgentCategory] ?? target);
    default: return target;
  }
}

export async function describeSettingChange(ctx: AccessContext, args: { key: SettingKey; target: string; value: string }): Promise<SettingView> {
  const t = tOf(ctx);
  const entry: SettingEntry = SETTING_CATALOG[args.key];
  const handler = SETTING_HANDLERS[args.key];
  const current = await Promise.resolve(handler.current(ctx, args.target)).catch(() => undefined);
  const name = entry.target ? targetName(ctx, entry, args.target) : "";
  let consequence = t(entry.consequence);
  // A schedule change is previewed as the plan page previews it: the week's planned hours and the milestones whose finish moves.
  if (handler.impact) {
    try {
      const change = await handler.impact(ctx, args.target, args.value);
      const impact = change ? await previewChange(ctx, change) : undefined;
      if (impact) consequence += t("；预览：未来 7 天排入 {{before}} → {{after}} 小时，{{count}} 个里程碑完成日变化", {
        before: (impact.week.plannedBefore / 60).toFixed(1), after: (impact.week.plannedAfter / 60).toFixed(1), count: impact.milestones.length });
    } catch { /* the card still says what follows, without numbers */ }
  }
  return { label: name ? t("{{label}}：{{name}}", { label: t(entry.label), name }) : t(entry.label), from: readable(ctx, entry.value, current),
    to: readable(ctx, entry.value, args.value.trim()), consequence, ...(entry.explain ? { explain: entry.explain.map((line) => t(line)) } : {}) };
}

export async function applySettingChange(ctx: AccessContext, args: { key: SettingKey; target: string; value: string }): Promise<Result> {
  const result = await SETTING_HANDLERS[args.key].apply(ctx, args.target.trim(), args.value.trim());
  if (!result.ok) return result;
  const entry: SettingEntry = SETTING_CATALOG[args.key];
  return { ok: true, message: tOf(ctx)("「{{label}}」已改为「{{value}}」", { label: tOf(ctx)(entry.label), value: readable(ctx, entry.value, args.value.trim()) }),
    href: result.href ?? (entry.section === "plan" ? "/plan" : entry.section === "milestones" ? "/milestones" : entry.section === "task" ? `/workbench/${encodeURIComponent(args.target)}`
      : `/settings#${entry.section}`) };
}

/** Every one-value-per-account setting with its current value, for the box's `list_settings`. */
export async function currentSettings(ctx: AccessContext): Promise<Array<{ key: string; current: string }>> {
  const keys = (Object.keys(SETTING_CATALOG) as SettingKey[]).filter((key) => !SETTING_CATALOG[key].target);
  return Promise.all(keys.map(async (key) => ({ key, current: String(await Promise.resolve(SETTING_HANDLERS[key].current(ctx, "")).catch(() => undefined) ?? "") })));
}
