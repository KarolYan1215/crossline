/**
 * Calendars read from a subscription address (docs/onboarding-v3.md 「日历接入」, decided 2026-10-14): the private iCal link that Apple
 * Calendar, Google Calendar and Outlook all export. Read-only, no sign-in, no dependence on the person's ChatGPT account.
 *
 * The link itself is a credential (anyone holding it can read the calendar), so it is kept in the worker's DPAPI secret store
 * (`ical-<id>`), never in the ledger, an export or a backup; the ledger keeps what can be shown — a label, the host and how the last
 * read went. A restored machine asks for the link again.
 */
export const CALENDAR_SUBSCRIPTIONS_SETTING = "calendar.subscriptions";

export type CalendarSubscription = {
  id: string;
  label: string;
  /** Where the link points (`p01-caldav.icloud.com`, `calendar.google.com`, `outlook.office365.com`); never the path, which holds the secret. */
  host: string;
  addedAt: string;
  /** The last read: when, how many timed events it gave inside the window, or why it failed. */
  lastReadAt?: string;
  lastEvents?: number;
  lastError?: string;
};

/** The secret store's name for a subscription's link. */
export const subscriptionSecretName = (id: string) => `ical-${id}`;

/** The source key a subscription's blocks carry in the plan (per-source authority in `createGraphSync`). */
export const subscriptionSourceKey = (id: string) => `ical:${id}`;

export function readSubscriptions(raw: string | undefined): CalendarSubscription[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is CalendarSubscription =>
      typeof item === "object" && item !== null && typeof (item as CalendarSubscription).id === "string" && typeof (item as CalendarSubscription).label === "string") : [];
  } catch { return []; }
}

/** Where each calendar app keeps the link, in the person's words; the card shows these as steps. */
export const SUBSCRIPTION_GUIDES: Array<{ app: string; steps: string[] }> = [
  { app: "苹果日历（iCloud）", steps: ["在 iPhone 或 Mac 的日历里，打开要接入的日历的「共享」设置", "打开「公开日历」", "拷贝出现的链接（以 webcal:// 开头），粘贴到这里"] },
  { app: "Google 日历", steps: ["在电脑浏览器打开 calendar.google.com，进入「设置」", "左侧选中要接入的日历，找到「集成日历」", "拷贝「iCal 格式的私密地址」，粘贴到这里"] },
  { app: "Outlook / Microsoft 365", steps: ["在 outlook.com 或 Outlook 网页版打开「设置 → 日历 → 共享日历」", "在「发布日历」里选日历、选「可以查看所有详细信息」，点「发布」", "拷贝 ICS 链接，粘贴到这里"] }
];

/** An event from a connected calendar (Graph or a subscription link) in the coming seven days, one per title, weekday and time. */
export type WeekCalendarEvent = { title: string; weekday: number; start: string; end: string; source: string };

/** Monday = 1 … Sunday = 7, the weekday numbering the availability windows use. */
const weekdayOf = (day: string) => { const weekday = new Date(`${day}T12:00:00Z`).getUTCDay(); return weekday === 0 ? 7 : weekday; };

/**
 * The connected calendars' events in the next seven days, from the current plan's `graph_calendar:` blocks (which subscriptions write
 * too): what the week already holds. Drawn under the interview's own reading of the week, and sent to the interview so its first questions
 * start from it (docs/onboarding-v3.md: 接入日历后可做推断，首轮问得更准). A weekly class appears once per weekday it falls on.
 */
export function calendarWeek(blocks: Array<{ id?: unknown; day?: unknown; title?: unknown; start?: unknown; end?: unknown; source?: unknown }>, today: string): WeekCalendarEvent[] {
  const end = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const seen = new Set<string>();
  const events: WeekCalendarEvent[] = [];
  for (const block of blocks) {
    const day = typeof block.day === "string" ? block.day : "";
    if (!String(block.id ?? "").startsWith("graph_calendar:") || !day || day < today || day >= end || typeof block.start !== "string" || typeof block.end !== "string") continue;
    const event = { title: String(block.title ?? ""), weekday: weekdayOf(day), start: block.start, end: block.end, source: String(block.source ?? "日历") };
    const key = `${event.title}|${event.weekday}|${event.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(event);
  }
  return events.sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start)).slice(0, 60);
}
