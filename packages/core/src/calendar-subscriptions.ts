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

/**
 * Where each calendar app keeps the link, in the person's words, and the page that holds it (`url`, opened by one button on the card, so
 * the person lands where the link is instead of hunting for it). Each `url` is the provider's own https page (checked by a test). `note`
 * is what goes wrong with that provider in particular (2026-11-22, the interview's preparation page: Google's slow refresh of calendars
 * added by URL, work and school accounts that switch the private address off, and what to do once a link has leaked).
 */
export const SUBSCRIPTION_GUIDES: Array<{ app: string; url: string; steps: string[]; note?: string }> = [
  { app: "Google 日历", url: "https://calendar.google.com/calendar/r/settings",
    steps: ["点「打开设置页」，在左侧「我的日历的设置」里点要接入的日历", "往下找到「集成日历」，拷贝「iCal 格式的私密地址」（不是「公开地址」）", "回到这里点「粘贴并接入」"],
    note: "学校或公司的 Google 账号，管理员可能关闭了私密地址，这时「集成日历」里没有这一项：改用个人账号，或请管理员开启。在 Google 日历里「通过网址添加」的外部日历（如学校课表），Google 要 12–24 小时才刷新一次；这类日历把它原本的订阅链接直接接到这里，变化来得更快。私密地址泄露了，就在同一处点「重置」，旧链接立即失效。" },
  { app: "Outlook（个人）", url: "https://outlook.live.com/calendar/0/options/calendar/SharedCalendars",
    steps: ["点「打开设置页」，在「共享日历」页的「发布日历」里选要接入的日历，权限选「可以查看所有详细信息」，点「发布」", "拷贝出现的 ICS 链接", "回到这里点「粘贴并接入」"],
    note: "拿到链接的人都能看这本日历。泄露了就在同一页点「取消发布」再重新发布，旧链接失效。" },
  { app: "Outlook（工作或学校）", url: "https://outlook.office.com/calendar/options/calendar/SharedCalendars",
    steps: ["点「打开设置页」，在「共享日历」页的「发布日历」里选要接入的日历，权限选「可以查看所有详细信息」，点「发布」", "拷贝出现的 ICS 链接", "回到这里点「粘贴并接入」"],
    note: "有的学校或公司关闭了日历发布，这时页面上没有「发布日历」：改用个人日历，或请管理员开启。链接泄露了就取消发布再重新发布，旧链接失效。" },
  { app: "苹果 iCloud", url: "https://www.icloud.com/calendar/",
    steps: ["点「打开设置页」，在 iCloud 日历里点要接入的日历旁的共享图标（在 iPhone 上是日历列表里的 ⓘ）", "打开「公开日历」，拷贝出现的链接（以 webcal:// 开头）", "回到这里点「粘贴并接入」"],
    note: "公开日历的链接任何拿到的人都能看。泄露了就关掉「公开日历」再打开，会生成新链接，旧的失效。" }
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
