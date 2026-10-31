import { spawn } from "node:child_process";
import { ATTENTION_SNAPSHOT, AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, BRIEF_TIME_SETTING, QUIET_HOURS_SETTING, inQuiet, inferWorkState, isClock, quietHoursOf, monthDay, resolveAvailability, tFor, type ActivitySegment, type AvailabilityWindow, type Locale } from "@crossline/core";
import type { CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";
import { ACTIVITY_DETAIL_CONSENT } from "./activity-recorder";
import { localeOf } from "./locale";

/**
 * Desktop notifications, in the rhythm the person chose: one morning brief, and single messages only when
 * something would otherwise be missed today — never a stream. The reasoning is alarm fatigue: clinicians
 * shown 100–200 alerts a day override about nine in ten, so a notification has to be rare to be read.
 * Work-block starts are not notified here; the Crossline calendar's own reminders cover those.
 */
export type NotifyLevel = "off" | "less" | "normal" | "more";
export const NOTIFY_LEVEL_SETTING = "notify.level";
const URGENT_PER_DAY: Record<NotifyLevel, number> = { off: 0, less: 0, normal: 2, more: 5 };
/** The web writes its snapshot every ten minutes; one older than half an hour means the web is not running. */
const ATTENTION_FRESH_MS = 30 * 60_000;

export type PlannedNotification = { key: string; title: string; body: string; path: string; kind: "brief" | "urgent" };

export type NotifyInput = {
  /** Local date and clock (`YYYY-MM-DD`, `HH:MM`) and weekday (0 = Sunday) in the person's zone. */
  today: string; clock: string; weekday: number;
  level: NotifyLevel;
  windows: AvailabilityWindow[];
  /** The person's quiet hours (`notify.quietHours`): nothing urgent is sent inside them. Omitted = none. */
  quiet?: { from: string; to: string };
  /** When the morning brief goes out (`notify.briefTime`); omitted = the day's first available hour. */
  briefAt?: string;
  /** Keys already sent (each key carries its own day where it should repeat daily). */
  sent: Set<string>;
  /** Single (non-brief) messages already sent today: the daily cap counts them. */
  urgentSentToday: number;
  pending: number;
  waitingDue: Array<{ id: string; who: string; title: string }>;
  dueSoon: Array<{ id: string; title: string; deadline: string; daysLeft: number }>;
  gateRefusals: Array<{ id: string; title: string; message: string }>;
  /** Work blocks that ended last night after the quiet hours began and were never confirmed (the brief says how many). */
  unconfirmedLastNight?: number;
  /**
   * The web's open asks (`lib/asks.ts`), when its snapshot is fresh. They then replace the three lists above as the
   * source of urgent messages — one definition of "needs you" for the badge, the brief and the desktop — and only an
   * ask that would cost a deadline within two days (`urgency: "now"`) interrupts.
   */
  asks?: Array<{ id: string; title: string; urgency: "now" | "soon" | "later"; path: string }>;
  /** The workspace's language: every message is written in it (omitted = Chinese). */
  locale?: Locale;
};

const inWindow = (input: NotifyInput) => input.windows.some((window) => window.days.includes(input.weekday)
  && window.start <= input.clock && input.clock < window.end);
const firstStart = (input: NotifyInput) => input.windows.filter((window) => window.days.includes(input.weekday))
  .map((window) => window.start).sort()[0];

/** Which notifications are due now. Pure: the clock, the settings and what was already sent decide everything. */
export function planNotifications(input: NotifyInput): PlannedNotification[] {
  if (input.level === "off") return [];
  const t = tFor(input.locale);
  const sep = input.locale === "en" ? "; " : "；";
  const out: PlannedNotification[] = [];
  const start = input.briefAt ?? firstStart(input);
  const briefKey = `brief:${input.today}`;
  // A morning brief belongs to the morning: from the first available hour for four hours. Turned on at 20:00 for the
  // first time (the day this was deployed), it used to send "today's" brief in the evening.
  const [h, m] = (start ?? "00:00").split(":").map(Number);
  const briefEnd = `${String(Math.min(23, h! + 4)).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  if (start && input.clock >= start && input.clock < briefEnd && !input.sent.has(briefKey)) {
    const lines = [
      ...input.waitingDue.map((item) => item.who ? t("今天该到：{{who}}的{{title}}", { who: item.who, title: item.title }) : t("今天该到：{{title}}", { title: item.title })),
      ...input.dueSoon.map((item) => item.daysLeft === 0 ? t("今天到期：{{title}}", { title: item.title })
        : t("{{count}} 天后到期：{{title}}", { count: item.daysLeft, title: item.title })),
      ...(input.asks ?? []).filter((ask) => ask.urgency === "now" && !ask.id.startsWith("wait:")).map((ask) => t("待决：{{title}}", { title: ask.title }))
    ].slice(0, 3);
    out.push({ key: briefKey, kind: "brief", path: "/", title: t("今天的 Crossline"),
      body: [...lines, input.unconfirmedLastNight ? t("昨晚 {{count}} 块待确认", { count: input.unconfirmedLastNight }) : "",
        input.pending ? t("{{count}} 项待决定", { count: input.pending }) : ""].filter(Boolean).join(sep) || t("今日无到期事项。") });
  }
  if (!inWindow(input) || (input.quiet && inQuiet(input.clock, input.quiet))) return out;
  const due = input.dueSoon.filter((item) => item.daysLeft <= 1).map((item) => ({ key: `due:${item.id}:${input.today}`, kind: "urgent" as const, path: "/milestones",
    title: item.daysLeft === 0 ? t("今天到期：{{title}}", { title: item.title }) : t("明天到期：{{title}}", { title: item.title }),
    body: t("截止 {{deadline}}。", { deadline: input.locale === "en" ? monthDay("en", item.deadline) : item.deadline }) }));
  const urgent: PlannedNotification[] = (input.asks
    ? [...input.asks.filter((ask) => ask.urgency === "now").map((ask) => ({ key: `ask:${ask.id}:${input.today}`, kind: "urgent" as const, path: ask.path,
      title: ask.title, body: t("关系到两天内的截止。打开 Crossline 选一个答案，或者让它明天再问。") })), ...due]
    : [
      ...input.waitingDue.map((item) => ({ key: `waiting:${item.id}:${input.today}`, kind: "urgent" as const, path: "/",
        title: item.who ? t("{{who}}的{{title}}到了吗？", { who: item.who, title: item.title }) : t("{{title}}到了吗？", { title: item.title }),
        body: t("到了就点「到了」，依赖它的工作才会排进日历。") })),
      ...due,
      // A gate *run* that did not happen (logged out, quota): not a verdict on the work, and no longer titled as one.
      ...input.gateRefusals.map((item) => ({ key: `gate:${item.id}`, kind: "urgent" as const, path: "/approvals",
        title: t("验收没跑成：{{title}}", { title: item.title }), body: item.message.slice(0, 120) }))
    ]).filter((item) => !input.sent.has(item.key));
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

/**
 * Whether the person is away from this computer now, by the screen record of the last quarter hour (`inferWorkState`), read only with
 * the detail consent the record exists under. Unknown is not away.
 */
export function awayFromScreen(store: CrosslineStore, workspaceId: string, now: Date): boolean {
  if (store.getSetting(workspaceId, ACTIVITY_DETAIL_CONSENT) !== "granted") return false;
  const segments: ActivitySegment[] = store.listActivitySegments(workspaceId, new Date(now.getTime() - 20 * 60_000).toISOString())
    .map((segment) => ({ start: segment.start, end: segment.end, app: segment.app, category: segment.category as ActivitySegment["category"], idle: segment.idle }));
  return inferWorkState({ segments, now: now.toISOString(), calendar: [] }).state === "away";
}

/**
 * One pass for one workspace. Each message goes to the desktop (`deliver`) and, when `push` is given, to the person's subscribed
 * phones; it is recorded as sent if either reached them, so a laptop that is closed does not make the phone ask again later. While
 * the screen record says the person is away from the computer (2026-10-20), a message goes to the phone only, and to the desktop
 * only if no phone took it — a toast on an empty desk is a message they find late and twice.
 */
export async function notifyPass(store: CrosslineStore, workspaceId: string, now: Date,
  deliver: (title: string, body: string, url: string) => Promise<boolean> = showToast, baseUrl = process.env.CROSSLINE_WEB_BASE_URL || "http://127.0.0.1:3210",
  push?: (workspaceId: string, message: { title: string; body: string; path: string; tag: string; start?: string; confirm?: string }) => Promise<boolean>): Promise<string[]> {
  const level = (store.getSetting(workspaceId, NOTIFY_LEVEL_SETTING) as NotifyLevel | undefined) ?? "normal";
  let zone = process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago";
  try { zone = (JSON.parse(store.getSetting(workspaceId, "schedule.preferences") ?? "null") as { timeZone?: string } | null)?.timeZone || zone; } catch { /* default */ }
  const { windows } = resolveAvailability({ saved: store.getSetting(workspaceId, AVAILABILITY_SETTING),
    proposed: store.getSetting(workspaceId, AVAILABILITY_PROPOSED_SETTING), facts: store.listProfileFacts(workspaceId) });
  const { today, clock, weekday } = localParts(now, zone);
  const away = Boolean(push) && awayFromScreen(store, workspaceId, now);
  const both = async (title: string, body: string, url: string, message: Parameters<NonNullable<typeof push>>[1]): Promise<boolean> => {
    const toPhone = () => push ? push(workspaceId, message).catch(() => false) : Promise.resolve(false);
    if (away) return await toPhone() || deliver(title, body, url);
    const [desktop, phone] = await Promise.all([deliver(title, body, url), toPhone()]);
    return desktop || phone;
  };
  const sentEvents = store.listEvents(workspaceId, { type: "notification.sent" });
  const sent = new Set(sentEvents.map((event) => String((event.payload as { key?: string }).key ?? "")));
  const urgentSentToday = sentEvents.filter((event) => (event.payload as { kind?: string; day?: string }).kind === "urgent"
    && (event.payload as { day?: string }).day === today).length;
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const daysLeft = (deadline: string) => Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  const accepted = new Set(store.listWorkOrders(workspaceId).filter((order) => order.state === "accepted").map((order) => order.milestoneId));
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order.intent]));
  // The web's view of what is waiting, when it is recent; otherwise the worker's own narrower reading.
  let attention: { at: string; pending: number; asks: NonNullable<NotifyInput["asks"]> } | undefined;
  try { attention = JSON.parse(store.getSetting(workspaceId, ATTENTION_SNAPSHOT) || "null") ?? undefined; } catch { attention = undefined; }
  if (attention && now.getTime() - Date.parse(attention.at) > ATTENTION_FRESH_MS) attention = undefined;
  const locale = localeOf(store, workspaceId);
  const briefAt = store.getSetting(workspaceId, BRIEF_TIME_SETTING) ?? "";
  const planned = planNotifications({ today, clock, weekday, level, windows, sent, urgentSentToday, locale,
    quiet: quietHoursOf(store.getSetting(workspaceId, QUIET_HOURS_SETTING)), ...(isClock(briefAt) ? { briefAt } : {}),
    ...(attention ? { asks: attention.asks } : {}),
    pending: attention?.pending ?? store.listWorkOrders(workspaceId).filter((order) => order.state === "awaiting_plan_approval").length
      + store.listMilestones(workspaceId).filter((milestone) => milestone.status === "draft").length,
    waitingDue: store.listWaitingItems(workspaceId, { state: "open" }).filter((item) => item.followUpAt <= today)
      .map((item) => ({ id: item.id, who: item.who, title: item.title })),
    dueSoon: store.listMilestones(workspaceId).filter((milestone) => milestone.status === "approved" && anchors.get(milestone.id) && !accepted.has(milestone.id))
      .map((milestone) => ({ id: milestone.id, title: milestone.title, deadline: anchors.get(milestone.id)!, daysLeft: daysLeft(anchors.get(milestone.id)!) }))
      .filter((item) => item.daysLeft >= 0 && item.daysLeft <= 3).sort((a, b) => a.daysLeft - b.daysLeft),
    gateRefusals: store.listEvents(workspaceId, { type: "milestone_gate.blocked" }).filter((event) => event.createdAt >= since)
      .map((event) => ({ id: event.eventId, title: orders.get(event.entityId) ?? tFor(locale)("一项作业"), message: String((event.payload as { message?: string }).message ?? "") })),
    unconfirmedLastNight: unconfirmedLastNight(store, workspaceId, today)
  });
  const delivered: string[] = [];
  for (const item of planned) {
    if (!await both(item.title, item.body, `${baseUrl}${item.path}`, { title: item.title, body: item.body, path: item.path, tag: item.key })) continue;
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `notify:${item.key}`, type: "notification.sent", entityId: workspaceId,
      payload: { key: item.key, kind: item.kind, day: today, title: item.title } });
    delivered.push(item.key);
  }
  // The system's own messages (docs/one-input.md §4) go to the desktop and phone only while no page is in front of the person; a page
  // shows them itself. A completion check goes out whatever page is open (the web marks it pending regardless). Each is sent once,
  // within the hour it was said, and its message records that it went out.
  const visibleAt = store.getSetting(workspaceId, "presence.visibleAt");
  const pageShown = Boolean(visibleAt) && now.getTime() - Date.parse(visibleAt!) <= PRESENCE_FRESH_MS;
  for (const message of store.listRecentNudges(workspaceId, new Date(now.getTime() - 3_600_000).toISOString())) {
    const nudge = message.payload.nudge as { delivery?: string; fingerprint?: string; kind?: string } | undefined;
    const text = (message.payload.card as { clarify?: { question?: string } } | undefined)?.clarify?.question ?? "";
    if (nudge?.delivery !== "pending" || !text) continue;
    const confirm = nudge.kind === "block_confirm";
    if (pageShown && !confirm) continue;
    const body = text.split("\n").slice(0, 3).join(" ").slice(0, 200);
    // A completion check opens its confirm page, where the answer is written by a POST (a link in a notification never writes); no
    // 「开始计时」 on it — the block is over. A nudge whose button starts a task (a block coming up, a latest start) carries that task, so
    // the phone's 「开始计时」 starts the timer in one tap.
    const start = confirm ? undefined : ((message.payload.card as { actions?: Array<{ action?: string; args?: { type?: string; workOrderId?: string } }> } | undefined)?.actions ?? [])
      .find((action) => action.action === "task.op" && action.args?.type === "start")?.args?.workOrderId;
    // The evening wrap-up opens its own page (a link that writes nothing, like the confirm page).
    const wrap = nudge.kind === "day_wrap";
    const path = confirm ? `/confirm/${encodeURIComponent(message.id)}` : wrap ? "/wrap" : start ? `/workbench/${encodeURIComponent(start)}` : "/";
    if (!await both("Crossline", body, `${baseUrl}${confirm || wrap ? path : "/"}`, { title: "Crossline", body, path, tag: nudge.fingerprint ?? message.id, ...(start ? { start } : {}),
      // A completion check carries its message: the phone answers 做了 / 没做 in place (docs/plans/closed-loop-1030.md §2).
      ...(confirm ? { confirm: message.id } : {}) })) continue;
    store.updateConversationPayload(workspaceId, message.id, { ...message.payload, nudge: { ...nudge, delivery: "pushed" } });
    delivered.push(`nudge:${nudge.fingerprint ?? message.id}`);
  }
  return delivered;
}

/** The quiet hours begin at 23:00; a block ending within the confirm window before them is not asked about either. */
const NIGHT_FROM = "22:30";

/**
 * Last night's work blocks nobody was asked about: they ended after the evening's questions stopped, and no confirmation was written.
 * Read from what the web's nudge pass saw under way (`nudge.blocks:<day>`), since the schedule itself is derived and keeps no past.
 */
export function unconfirmedLastNight(store: CrosslineStore, workspaceId: string, today: string): number {
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  let seen: Record<string, { id: string; end: string; began?: boolean }> = {};
  try { seen = JSON.parse(store.getSetting(workspaceId, `nudge.blocks:${yesterday}`) ?? "{}"); } catch { return 0; }
  const confirmed = new Set(store.listEvents(workspaceId, { type: "block.confirmed" })
    .filter((event) => (event.payload as { day?: string }).day === yesterday).map((event) => String((event.payload as { blockId?: string }).blockId)));
  // The evening wrap-up (docs/rituals.md) holds every block whose task is not due by the next day; a day not wrapped up leaves all of them
  // unconfirmed, so the brief counts all of them, not only the ones that ended in the quiet hours.
  const wrapped = Boolean(store.getSetting(workspaceId, `wrap.done:${yesterday}`));
  return Object.values(seen).filter((block) => block.began && (!wrapped || block.end >= NIGHT_FROM) && !confirmed.has(block.id)).length;
}

/** A page seen this recently is in front of the person; the web's `PRESENCE_FRESH_MS`, kept equal. */
const PRESENCE_FRESH_MS = 10 * 60_000;
