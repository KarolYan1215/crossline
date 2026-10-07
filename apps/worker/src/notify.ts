import { spawn } from "node:child_process";
import { DEFAULT_AVAILABILITY, type AvailabilityWindow } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";

/**
 * Desktop notifications, in the rhythm the person chose: one morning brief, and single messages only when
 * something would otherwise be missed today — never a stream. The reasoning is alarm fatigue: clinicians
 * shown 100–200 alerts a day override about nine in ten, so a notification has to be rare to be read.
 * Work-block starts are not notified here; the Crossline calendar's own reminders cover those.
 */
export type NotifyLevel = "off" | "less" | "normal" | "more";
export const NOTIFY_LEVEL_SETTING = "notify.level";
const URGENT_PER_DAY: Record<NotifyLevel, number> = { off: 0, less: 0, normal: 2, more: 5 };

export type PlannedNotification = { key: string; title: string; body: string; path: string; kind: "brief" | "urgent" };

export type NotifyInput = {
  /** Local date and clock (`YYYY-MM-DD`, `HH:MM`) and weekday (0 = Sunday) in the person's zone. */
  today: string; clock: string; weekday: number;
  level: NotifyLevel;
  windows: AvailabilityWindow[];
  /** Keys already sent (each key carries its own day where it should repeat daily). */
  sent: Set<string>;
  /** Single (non-brief) messages already sent today: the daily cap counts them. */
  urgentSentToday: number;
  pending: number;
  waitingDue: Array<{ id: string; who: string; title: string }>;
  dueSoon: Array<{ id: string; title: string; deadline: string; daysLeft: number }>;
  gateRefusals: Array<{ id: string; title: string; message: string }>;
};

const inWindow = (input: NotifyInput) => input.windows.some((window) => window.days.includes(input.weekday)
  && window.start <= input.clock && input.clock < window.end);
const firstStart = (input: NotifyInput) => input.windows.filter((window) => window.days.includes(input.weekday))
  .map((window) => window.start).sort()[0];

/** Which notifications are due now. Pure: the clock, the settings and what was already sent decide everything. */
export function planNotifications(input: NotifyInput): PlannedNotification[] {
  if (input.level === "off") return [];
  const out: PlannedNotification[] = [];
  const start = firstStart(input);
  const briefKey = `brief:${input.today}`;
  if (start && input.clock >= start && !input.sent.has(briefKey)) {
    const lines = [
      ...input.waitingDue.map((item) => `今天该到：${item.who ? `${item.who}的` : ""}${item.title}`),
      ...input.dueSoon.map((item) => `${item.daysLeft === 0 ? "今天" : `${item.daysLeft} 天后`}到期：${item.title}`)
    ].slice(0, 3);
    out.push({ key: briefKey, kind: "brief", path: "/", title: "今天的 Crossline",
      body: [...lines, input.pending ? `${input.pending} 件等你决定` : ""].filter(Boolean).join("；") || "今天没有到期的事，按计划来。" });
  }
  if (!inWindow(input)) return out;
  const urgent: PlannedNotification[] = [
    ...input.waitingDue.map((item) => ({ key: `waiting:${item.id}:${input.today}`, kind: "urgent" as const, path: "/",
      title: `${item.who ? `${item.who}的` : ""}${item.title}到了吗？`, body: "到了就点「到了，排上」，依赖它的工作才会排进日历。" })),
    ...input.dueSoon.filter((item) => item.daysLeft <= 1).map((item) => ({ key: `due:${item.id}:${input.today}`, kind: "urgent" as const, path: "/milestones",
      title: `${item.daysLeft === 0 ? "今天" : "明天"}到期：${item.title}`, body: `截止 ${item.deadline}。` })),
    ...input.gateRefusals.map((item) => ({ key: `gate:${item.id}`, kind: "urgent" as const, path: "/approvals",
      title: `没通过验收：${item.title}`, body: item.message.slice(0, 120) }))
  ].filter((item) => !input.sent.has(item.key));
  return [...out, ...urgent.slice(0, Math.max(0, URGENT_PER_DAY[input.level] - input.urgentSentToday))];
}

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Shows one Windows toast through the WinRT API already on the machine — no package to install. Clicking it
 * opens the page it names in the browser. The script is passed encoded, so nothing in a title can break out
 * of it as PowerShell.
 */
export function showToast(title: string, body: string, url: string): Promise<boolean> {
  if (process.platform !== "win32") return Promise.resolve(false);
  const template = `<toast activationType="protocol" launch="${xml(url)}"><visual><binding template="ToastGeneric"><text>${xml(title)}</text><text>${xml(body)}</text></binding></visual></toast>`;
  const script = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null",
    "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
    `$doc.LoadXml([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(template, "utf8").toString("base64")}')))`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($toast)"
  ].join("\n");
  return new Promise((resolve) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { stdio: "ignore", windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

const localParts = (now: Date, zone: string) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short" }).formatToParts(now).map((part) => [part.type, part.value]));
  return { today: `${parts.year}-${parts.month}-${parts.day}`, clock: `${parts.hour}:${parts.minute}`,
    weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday)) };
};

/** One pass for one workspace: reads what it needs, plans, delivers, and records each sent message once. */
export async function notifyPass(store: CrosslineStore, workspaceId: string, now: Date,
  deliver: (title: string, body: string, url: string) => Promise<boolean> = showToast, baseUrl = "http://127.0.0.1:3210"): Promise<string[]> {
  const level = (store.getSetting(workspaceId, NOTIFY_LEVEL_SETTING) as NotifyLevel | undefined) ?? "normal";
  let zone = process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago";
  try { zone = (JSON.parse(store.getSetting(workspaceId, "schedule.preferences") ?? "null") as { timeZone?: string } | null)?.timeZone || zone; } catch { /* default */ }
  let windows = DEFAULT_AVAILABILITY;
  try { windows = (JSON.parse(store.getSetting(workspaceId, "schedule.availability") ?? "null") as AvailabilityWindow[] | null) ?? windows; } catch { /* default */ }
  const { today, clock, weekday } = localParts(now, zone);
  const sentEvents = store.listEvents(workspaceId, { type: "notification.sent" });
  const sent = new Set(sentEvents.map((event) => String((event.payload as { key?: string }).key ?? "")));
  const urgentSentToday = sentEvents.filter((event) => (event.payload as { kind?: string; day?: string }).kind === "urgent"
    && (event.payload as { day?: string }).day === today).length;
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const daysLeft = (deadline: string) => Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const accepted = new Set(store.listWorkOrders(workspaceId).filter((order) => order.state === "accepted").map((order) => order.milestoneId));
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order.intent]));
  const planned = planNotifications({ today, clock, weekday, level, windows, sent, urgentSentToday,
    pending: store.listWorkOrders(workspaceId).filter((order) => order.state === "awaiting_plan_approval").length
      + store.listMilestones(workspaceId).filter((milestone) => milestone.status === "draft").length,
    waitingDue: store.listWaitingItems(workspaceId, { state: "open" }).filter((item) => item.followUpAt <= today)
      .map((item) => ({ id: item.id, who: item.who, title: item.title })),
    dueSoon: store.listMilestones(workspaceId).filter((milestone) => milestone.status === "approved" && anchors.get(milestone.id) && !accepted.has(milestone.id))
      .map((milestone) => ({ id: milestone.id, title: milestone.title, deadline: anchors.get(milestone.id)!, daysLeft: daysLeft(anchors.get(milestone.id)!) }))
      .filter((item) => item.daysLeft >= 0 && item.daysLeft <= 3).sort((a, b) => a.daysLeft - b.daysLeft),
    gateRefusals: store.listEvents(workspaceId, { type: "milestone_gate.blocked" }).filter((event) => event.createdAt >= since)
      .map((event) => ({ id: event.eventId, title: orders.get(event.entityId) ?? "一项作业", message: String((event.payload as { message?: string }).message ?? "") }))
  });
  const delivered: string[] = [];
  for (const item of planned) {
    if (!(await deliver(item.title, item.body, `${baseUrl}${item.path}`))) continue;
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `notify:${item.key}`, type: "notification.sent", entityId: workspaceId,
      payload: { key: item.key, kind: item.kind, day: today, title: item.title } });
    delivered.push(item.key);
  }
  return delivered;
}
