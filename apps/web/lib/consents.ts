import "server-only";
import { assistantAvailable as machineOwner } from "@crossline/db";
import { AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, ACTIVITY_LAST_ACTIVE, ACTIVITY_LONG_GAPS, CAMERA_ENERGY_CONSENT, ENERGY_ADVICE_DISMISSED, ENERGY_ADVICE_SETTING,
  INPUT_RHYTHM_BUCKETS, INPUT_RHYTHM_CONSENT, SLEEP_TRACKING_CONSENT, TELEMETRY_ENABLED_SETTING, readEnergyAdvice, type AccessContext } from "@crossline/core";
import { ACTIVITY_DETAIL_CONSENT, dataDirectory, getStore, LOCAL_ACTIVITY_CONSENT } from "./crossline";
import { setPhoneHealth } from "./energy";
import { serverTranscribeAvailable, setRecordingConsent, setServerRecordingConsent, setVoiceprintConsent } from "./recordings";

/**
 * The switches the settings page and the input box share (docs/one-input.md 「设置」): each route under `/api/settings/*` and
 * `setting.change` call the same function here, so turning a consent off deletes exactly what the page's switch deletes, and a reading of
 * this computer stays its owner's whichever way it is asked.
 */
export type SwitchResult = { ok: true; deleted?: number; discarded?: number } | { ok: false; code: string };
const ownerOnly = (ctx: AccessContext, on: boolean): SwitchResult | undefined =>
  on && !machineOwner(getStore(), ctx.workspaceId) ? { ok: false, code: "MACHINE_OWNER_ONLY" } : undefined;

/** 作息记录: off deletes the long idle stretches kept. */
export function setSleepTracking(ctx: AccessContext, on: boolean): SwitchResult {
  const refused = ownerOnly(ctx, on);
  if (refused) return refused;
  const store = getStore();
  store.setSetting(ctx.workspaceId, SLEEP_TRACKING_CONSENT, on ? "granted" : "denied");
  if (!on) { store.deleteSetting(ctx.workspaceId, ACTIVITY_LAST_ACTIVE); store.deleteSetting(ctx.workspaceId, ACTIVITY_LONG_GAPS); }
  return { ok: true };
}

/** 键鼠节律, 摄像头精力采样 and 手机健康数据; off deletes what each kept. */
export function setEnergySignal(ctx: AccessContext, signal: "input_rhythm" | "camera" | "phone_health", on: boolean): SwitchResult {
  if (signal === "input_rhythm") { const refused = ownerOnly(ctx, on); if (refused) return refused; }
  const store = getStore(), ws = ctx.workspaceId;
  if (signal === "phone_health") setPhoneHealth(ws, on);
  else if (signal === "input_rhythm") {
    store.setSetting(ws, INPUT_RHYTHM_CONSENT, on ? "granted" : "denied");
    if (!on) store.deleteSetting(ws, INPUT_RHYTHM_BUCKETS);
  } else {
    store.setSetting(ws, CAMERA_ENERGY_CONSENT, on ? "granted" : "denied");
    if (!on) store.deleteEnergyObservations(ws, "camera_aggregate");
  }
  return { ok: true };
}

/** Screen activity's two consents as the settings card sends them: off turns the detail off too; the detail grants the minutes too. */
export function setActivityConsent(ctx: AccessContext, change: { consent?: "granted" | "denied"; detail?: "granted" | "denied" }): SwitchResult {
  const refused = ownerOnly(ctx, change.consent === "granted" || change.detail === "granted");
  if (refused) return refused;
  const store = getStore(), ws = ctx.workspaceId;
  if (change.consent) {
    store.setSetting(ws, LOCAL_ACTIVITY_CONSENT, change.consent);
    if (change.consent === "denied") store.setSetting(ws, ACTIVITY_DETAIL_CONSENT, "denied");
  }
  if (change.detail) {
    store.setSetting(ws, ACTIVITY_DETAIL_CONSENT, change.detail);
    if (change.detail === "granted") store.setSetting(ws, LOCAL_ACTIVITY_CONSENT, "granted");
  }
  return { ok: true };
}
export type ScreenLevel = "off" | "minutes" | "detail";
/** The card's three levels, as its segmented control sends them. */
export const SCREEN_LEVEL_CHANGE: Record<ScreenLevel, { consent?: "granted" | "denied"; detail?: "granted" | "denied" }> = {
  off: { consent: "denied" }, minutes: { consent: "granted", detail: "denied" }, detail: { detail: "granted" } };
export function screenLevel(ctx: AccessContext): ScreenLevel {
  const store = getStore();
  return store.getSetting(ctx.workspaceId, ACTIVITY_DETAIL_CONSENT) === "granted" ? "detail" : store.getSetting(ctx.workspaceId, LOCAL_ACTIVITY_CONSENT) === "granted" ? "minutes" : "off";
}

/** Codex and Claude Code history, time only: off forgets the summary. */
export function setAgentHistory(ctx: AccessContext, on: boolean): SwitchResult {
  const refused = ownerOnly(ctx, on);
  if (refused) return refused;
  const store = getStore();
  store.setSetting(ctx.workspaceId, AGENT_HISTORY_CONSENT, on ? "on" : "off");
  if (!on) store.setSetting(ctx.workspaceId, AGENT_HISTORY_SUMMARY, "null");
  return { ok: true };
}

/** 录音自动转写 (this computer's own files): off with `keep` false deletes the transcripts made. */
export function setRecordings(ctx: AccessContext, on: boolean, keep: boolean): SwitchResult {
  const refused = ownerOnly(ctx, on);
  if (refused) return refused;
  return { ok: true, ...setRecordingConsent(getStore(), ctx.workspaceId, on, { keep, dataDir: dataDirectory(), ownerId: ctx.principalId }) };
}
/** 录音在服务器转写: off always deletes the recordings still waiting; `keep` decides the transcripts. */
export function setServerRecordings(ctx: AccessContext, on: boolean, keep: boolean): SwitchResult {
  if (on && !serverTranscribeAvailable()) return { ok: false, code: "SERVER_TRANSCRIBE_UNAVAILABLE" };
  return { ok: true, ...setServerRecordingConsent(getStore(), ctx.workspaceId, on, { keep, dataDir: dataDirectory(), ownerId: ctx.principalId }) };
}
/** 识别本人声音: off deletes the voiceprint. */
export function setVoiceprint(ctx: AccessContext, on: boolean): SwitchResult {
  if (on && !serverTranscribeAvailable()) return { ok: false, code: "SERVER_TRANSCRIBE_UNAVAILABLE" };
  return { ok: true, ...setVoiceprintConsent(getStore(), ctx.workspaceId, on, dataDirectory()) };
}

export const NOTIFY_LEVELS = ["off", "less", "normal", "more"] as const;
export function setNotifyLevel(ctx: AccessContext, level: string): SwitchResult {
  if (!(NOTIFY_LEVELS as readonly string[]).includes(level)) return { ok: false, code: "INVALID_NOTIFY_LEVEL" };
  getStore().setSetting(ctx.workspaceId, "notify.level", level);
  return { ok: true };
}

export function setTelemetry(ctx: AccessContext, on: boolean): SwitchResult {
  getStore().setSetting(ctx.workspaceId, TELEMETRY_ENABLED_SETTING, on ? "1" : "0");
  return { ok: true };
}

/** 「忽略」 this week's energy advice: only the current advice, and only it (`id` when the page names it). */
export function dismissEnergyAdvice(ctx: AccessContext, id?: string): SwitchResult {
  const store = getStore();
  const advice = readEnergyAdvice(store.getSetting(ctx.workspaceId, ENERGY_ADVICE_SETTING));
  if (!advice || !("id" in advice) || (id !== undefined && id !== advice.id)) return { ok: false, code: "ENERGY_ADVICE_NOT_CURRENT" };
  store.setSetting(ctx.workspaceId, ENERGY_ADVICE_DISMISSED, advice.id);
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `energy.advice.dismissed:${advice.id}`,
    type: "energy.advice.dismissed", entityId: ctx.workspaceId, payload: { id: advice.id } });
  return { ok: true };
}
