import "server-only";
import { randomUUID } from "node:crypto";
import { isPaused } from "@crossline/db";
import {
  DEFAULT_REMINDER_TIME, REMINDERS_SETTING, departureTime, isOnlineLocation, occurrences, travelMinutesFor, workOwner, type AccessContext, type Reminder, type TravelState
} from "@crossline/core";
import { approveWorkOrderProposal, effectiveSchedulePreferences, getStore, planToday, toZonedInstant, travelStateOf } from "./crossline";
import { inputEvents } from "./fixed-events";
import { addNotice } from "./notices";
import { refreshTravelEstimates } from "./travel";
import { errandFiles, errands } from "./errands";

const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const squash = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, "").toLowerCase();
const json = <T,>(raw: string | undefined, fallback: T): T => { try { return (raw ? JSON.parse(raw) : null) ?? fallback; } catch { return fallback; } };
/** A reminder that comes due this long after its moment (the server was down) is dropped, not said late. */
const STALE_MS = 12 * 3_600_000;
const NOTICED_SETTING = "life.errands.noticed";

export const readReminders = (ctx: AccessContext): Reminder[] => json<Reminder[]>(getStore().getSetting(ctx.workspaceId, REMINDERS_SETTING), []);
const writeReminders = (ctx: AccessContext, list: Reminder[]) => getStore().setSetting(ctx.workspaceId, REMINDERS_SETTING, JSON.stringify(list.slice(-200)));

/** Sets a reminder that needs no work (「明天上午提醒我取快递」): said in the bell at its time, and on the phone when no page is open. */
export function addReminder(ctx: AccessContext, input: Omit<Reminder, "id" | "firedAt">): Reminder {
  const reminder: Reminder = { ...input, id: `rem-${randomUUID()}`, date: input.date || planToday(ctx), time: input.time || (input.departure ? "" : DEFAULT_REMINDER_TIME) };
  writeReminders(ctx, [...readReminders(ctx), reminder]);
  return reminder;
}

/** The start of the event a departure is for: the one given, else the person's own event of that day with the same name. */
function eventStart(ctx: AccessContext, reminder: Reminder): string {
  if (reminder.departure?.start) return reminder.departure.start;
  const name = squash(reminder.departure?.title ?? "");
  const event = inputEvents(ctx).find((item) => occurrences(item, [reminder.date]).length && name && (squash(item.title).includes(name) || name.includes(squash(item.title))));
  return event?.start ?? "";
}

/** When a reminder is said (local time), and its words: a departure reminder works out when to leave from the travel time known then. */
export function reminderMoment(ctx: AccessContext, reminder: Reminder, state: TravelState = travelStateOf(ctx)): { time: string; text: string } {
  if (!reminder.departure) return { time: reminder.time || DEFAULT_REMINDER_TIME, text: reminder.text };
  const { title, location } = reminder.departure;
  const start = eventStart(ctx, reminder);
  const travel = travelMinutesFor(location, state);
  const time = start ? departureTime(start, travel.minutes) : DEFAULT_REMINDER_TIME;
  const leave = travel.minutes ? `，路上约 ${travel.minutes} 分钟，宜 ${time} 出发` : "";
  const checks = reminder.checklist?.length ? `出门前检查：${reminder.checklist.join("、")}。` : "";
  const prep = reminder.errandOrderId ? (errandFiles(ctx, reminder.errandOrderId).length ? "准备材料已备好。" : "准备材料未能备好。") : "";
  return { time, text: `「${title}」${start ? `${start} 开始` : "今天"}${location && !isOnlineLocation(location) ? `（${location}）` : ""}${leave}。${checks}${prep}` };
}

/** Says every reminder whose moment has come, once (marked before it is said). Returns how many were said. */
export function deliverDueReminders(ctx: AccessContext, now = new Date()): number {
  const list = readReminders(ctx);
  if (!list.some((item) => !item.firedAt)) return 0;
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const state = travelStateOf(ctx);
  const due: Array<{ reminder: Reminder; text: string }> = [];
  const next = list.map((reminder) => {
    if (reminder.firedAt) return reminder;
    const moment = reminderMoment(ctx, reminder, state);
    let at: number;
    try { at = Date.parse(toZonedInstant(reminder.date, moment.time, zone)); } catch { return { ...reminder, firedAt: now.toISOString() }; }
    if (at > now.getTime()) return reminder;
    if (now.getTime() - at <= STALE_MS) due.push({ reminder, text: moment.text });
    return { ...reminder, firedAt: now.toISOString() };
  });
  if (next.every((item, index) => item === list[index])) return 0;
  writeReminders(ctx, next);
  for (const { reminder, text } of due) {
    const files = reminder.errandOrderId ? errandFiles(ctx, reminder.errandOrderId) : [];
    addNotice(ctx, text, reminder.departure ? "departure" : "reminder", files.slice(0, 1).map((file) => ({ label: "看准备", href: file.href })), now);
  }
  return due.length;
}

export type ErrandRequest = { title: string; goal: string; location: string; date: string; startTime: string; prepare: string; checklist: string[]; lineId: string };

/**
 * An outing, a trip, an errand or an appointment the assistant can prepare for (「周六去 Costco」「下周去芝加哥玩两天」): an assistant-owned
 * item (docs/work-split.md) that takes effect at once and is handed over whole — the assistant researches and writes the itinerary, the
 * list, directions, opening hours, what to bring — plus a departure reminder that lists the checks before leaving. The event itself is
 * `event.create`; this is its preparation.
 */
export function createErrand(ctx: AccessContext, request: ErrandRequest): { ok: true; orderId: string; message: string } | { ok: false; code: string; message: string } {
  const store = getStore();
  const date = request.date || planToday(ctx);
  const title = request.title.trim().slice(0, 120);
  if (!title) return { ok: false, code: "ERRAND_TITLE_REQUIRED", message: "缺少事项名称" };
  const id = `errand-${randomUUID()}`;
  const prepare = request.prepare.trim() || "行程、要带的东西与注意事项";
  // What it is named by decides who may do it (`workOwner`): the event's own words (预约, 参加, 购买) would read as the person's act, so
  // the name says only that this is preparation; the event is described in the part handed over.
  const named = (text: string) => ({ title: text, intent: text, payload: { owner: "assistant" } });
  const intent = workOwner(named(`${md(date)} 生活安排的准备：${prepare}`)).owner === "assistant" ? `${md(date)} 生活安排的准备：${prepare}` : `${md(date)} 生活安排的准备材料`;
  const checklist = request.checklist.map((item) => item.trim()).filter(Boolean).slice(0, 8);
  const spec = [`事项：「${title}」，${date}${request.startTime ? ` ${request.startTime} 开始` : ""}${request.location ? `，地点 ${request.location}` : ""}。`,
    request.goal.trim() ? `目的：${request.goal.trim()}。` : "", `要准备：${prepare}。`,
    "写成一份本人拿来就能用的 Markdown：按事项需要给出行程与时间安排、清单、路线与交通、营业或开放时间、费用、天气、要带的东西与注意事项；"
      + "查得到的用网上公开信息查清并注明来源，查不到的写明待本人确认。",
    "若它占用较长时间或影响本人别的安排，在文末写「对日程的建议」：哪些时段要空出来、哪些事提前或推后。不直接改日程。",
    checklist.length ? `出门前检查（可补充）：${checklist.join("、")}。` : "",
    "只查资料、整理与建议：不预约、不下单、不付款、不联系任何人。"].filter(Boolean).join("\n");
  const ownerId = store.getWorkspaceOwnerId(ctx.workspaceId) ?? ctx.principalId;
  const reminder = addReminder(ctx, { text: title, date, time: "", checklist, departure: { title, location: request.location.trim(), start: request.startTime }, errandOrderId: id });
  store.saveWorkOrder({ id, ownerId, workspaceId: ctx.workspaceId, identityId: request.lineId, projectId: "", milestoneId: "", intent, state: "awaiting_plan_approval",
    riskTier: "routine", estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { title: intent, owner: "assistant", ownerReason: "生活安排的准备：查资料、列清单，不占本人时间",
      errand: { title, date, start: request.startTime, location: request.location.trim(), prepare, checklist, reminderId: reminder.id },
      automationParts: [{ id: `${id}-ai`, intent: spec, rationale: "本人在输入框说了这件事" }], humanCore: [], materialContract: [],
      evidenceContract: [{ kind: "record", description: "一份可直接使用的准备文件（Markdown）", why: "生活安排的准备", required: true }] } });
  const approved = approveWorkOrderProposal(ctx, id);
  if (!approved.ok) return { ok: false, code: approved.code, message: "准备工作未能建立" };
  const paused = isPaused(store, ctx.workspaceId);
  return { ok: true, orderId: id, message: paused ? "助手已暂停，准备材料暂不生成；出发提醒已设好" : `助手开始准备「${prepare}」，好了会在提醒里说；出发前会提醒` };
}

/** Says once that an errand's preparation is ready, with a link to it. */
export function noticeReadyErrands(ctx: AccessContext, now = new Date()): number {
  const store = getStore();
  const noticed = new Set(json<string[]>(store.getSetting(ctx.workspaceId, NOTICED_SETTING), []));
  let said = 0;
  for (const errand of errands(ctx)) {
    if (noticed.has(errand.orderId)) continue;
    const files = errandFiles(ctx, errand.orderId);
    if (!files.length) continue;
    noticed.add(errand.orderId);
    store.setSetting(ctx.workspaceId, NOTICED_SETTING, JSON.stringify([...noticed].slice(-200)));
    addNotice(ctx, `「${errand.title}」（${md(errand.date)}）的准备已备好：${files.slice(0, 3).map((file) => file.name).join("、")}。`, "errand_ready",
      files.slice(0, 2).map((file, index) => ({ label: index ? file.name : "看准备", href: file.href })), now);
    said += 1;
  }
  return said;
}

/** The two-minute pass's share for the person's life: reminders due, errands ready, map estimates. Each part fails on its own. */
export async function lifePass(ctx: AccessContext, now = new Date()): Promise<void> {
  try { deliverDueReminders(ctx, now); } catch { /* next pass */ }
  try { noticeReadyErrands(ctx, now); } catch { /* next pass */ }
  try { await refreshTravelEstimates(ctx); } catch { /* next pass */ }
}
