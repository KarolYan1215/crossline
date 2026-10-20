/**
 * What the screen says about how work is going, kept apart from what the screen said.
 *
 * A window title can name a person, a page, a document or an account, so nothing here lets one travel: the only type
 * the rest of the system sees (`ActivitySegment`) has an app and a category and no title at all, and the title is used
 * once, locally, to pick the category and then stays in the store the person can read and clear. A model context built
 * from segments therefore cannot contain a title, because there is no field to put it in.
 */
export const ACTIVITY_CATEGORIES = ["coding", "research_tool", "writing", "reading", "communication", "meeting", "browsing", "leisure", "other"] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const CATEGORY_LABEL: Record<ActivityCategory | "idle", string> = {
  coding: "编程", research_tool: "科研工具", writing: "写作", reading: "阅读", communication: "沟通", meeting: "会议",
  browsing: "浏览", leisure: "娱乐", other: "其它", idle: "离开"
};
/** Categories that count as working on something. Browsing is neither: it depends on what is in the tab, which is the title. */
export const PRODUCTIVE: ReadonlySet<ActivityCategory> = new Set(["coding", "research_tool", "writing", "reading"]);

/** One reading from a source: the instant, how long since input, the foreground app, and the title of its window. */
/**
 * `rhythm` (Windows source, docs/energy-and-ecosystem.md §8): over the reading's interval, how many seconds had input, how many pauses of
 * five seconds or more broke it, and how far the pointer travelled in pixels — timing and distance only, never a key or a position.
 */
export type InputRhythm = { activeSec: number; pauses: number; mousePx: number };
export type ActivityReading = { at: string; idleMs: number; app: string; title: string; rhythm?: InputRhythm };

/**
 * When the person is at the computer, hour by hour (2026-10-20, the owner asked for idle time to be kept as information about the person):
 * active and idle minutes per clock hour, the last 28 days, under the same consent as the daily aggregate (localActivity.consent, or the
 * detailed level) — minutes only, no app, no title. Off deletes them. `atComputerByHour` turns them into the person's usual day.
 */
export const ACTIVITY_HOURLY = "activity.hourly";
export const ACTIVITY_HOURLY_DAYS = 28;
export type ActivityHour = { start: string; active: number; idle: number };

/**
 * The usual day at the computer: for each local hour, the average active minutes over the days that have any reading, and the share of
 * those days on which the person was active in that hour at all. Undefined before three days of readings.
 */
export function atComputerByHour(hours: ActivityHour[], timeZone: string): { days: number; active: number[]; present: number[] } | undefined {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
  const byDay = new Map<string, number[]>();
  for (const hour of hours) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(hour.start)).map((part) => [part.type, part.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`, at = Number(parts.hour) % 24;
    const row = byDay.get(day) ?? Array.from({ length: 24 }, () => 0);
    row[at]! += hour.active;
    byDay.set(day, row);
  }
  if (byDay.size < 3) return undefined;
  const rows = [...byDay.values()];
  const active = Array.from({ length: 24 }, (_, at) => Math.round(rows.reduce((sum, row) => sum + row[at]!, 0) / rows.length));
  const present = Array.from({ length: 24 }, (_, at) => Math.round((rows.filter((row) => row[at]! >= 5).length / rows.length) * 100) / 100);
  return { days: rows.length, active, present };
}

/** The usual day at the computer in words, for the interview and the portrait (habits, not the schedule): the hours present on most days. */
export function atComputerLines(hours: ActivityHour[], timeZone: string): string[] {
  const day = atComputerByHour(hours, timeZone);
  if (!day) return [];
  const ranges: string[] = [];
  for (let at = 0; at < 24; at += 1) {
    if (day.present[at]! < 0.5) continue;
    let end = at;
    while (end + 1 < 24 && day.present[end + 1]! >= 0.5) end += 1;
    ranges.push(`${at}–${end + 1} 点`);
    at = end;
  }
  const total = Math.round(day.active.reduce((sum, minutes) => sum + minutes, 0) / 6) / 10;
  return [`电脑前（近 ${day.days} 天，屏幕活动记录，只计分钟）：平均每天活跃约 ${total} 小时${ranges.length ? `，多数日子在 ${ranges.join("、")}` : ""}`];
}

/** 键鼠节律, its own consent (off unless turned on; off deletes what was kept), and where its quarter-hour totals are kept (14 days). */
export const INPUT_RHYTHM_CONSENT = "activity.inputRhythm";
export const INPUT_RHYTHM_BUCKETS = "activity.inputRhythm.buckets";
export type InputRhythmBucket = { start: string; minutes: number; activeSec: number; pauses: number; mousePx: number };

/**
 * The input rhythm over the hour before `at`, as the energy model's two candidate covariates: pauses per minute of input (how broken
 * up the work is) and pointer travel per second of input. Undefined with under ten minutes of input in that hour.
 */
export function inputRhythmAt(buckets: InputRhythmBucket[], at: string): { fragmentation: number; pointerPace: number } | undefined {
  const end = Date.parse(at), start = end - 3_600_000;
  const within = buckets.filter((bucket) => Date.parse(bucket.start) >= start - 15 * 60_000 && Date.parse(bucket.start) < end);
  const active = within.reduce((sum, bucket) => sum + bucket.activeSec, 0);
  if (active < 600) return undefined;
  return { fragmentation: within.reduce((sum, bucket) => sum + bucket.pauses, 0) / (active / 60),
    pointerPace: within.reduce((sum, bucket) => sum + bucket.mousePx, 0) / active };
}

/**
 * Where readings come from. The Windows foreground window is one; a wearable that reports heart rate or a phone that reports
 * screen-on time would be another, each mapping what it knows to an app-like name and, if it has none, an empty title.
 */
export interface ActivitySource {
  readonly id: string;
  start(onReading: (reading: ActivityReading) => void): void;
  stop(): void;
}

/** What may leave the store: no title. */
export type ActivitySegment = { start: string; end: string; app: string; category: ActivityCategory; idle: boolean };
export type ActivityRule = { match: string; category: ActivityCategory };

// ---------------------------------------------------------------------------------------------------------------------
// What is never recorded

const PRIVATE_APPS = /^(1password|bitwarden|keepass|keepassxc|lastpass|dashlane|enpass|authy|nordpass)(\.exe)?$/i;
const PRIVATE_TITLE = /inprivate|incognito|private browsing|private window|无痕|隐私浏览|隐身|隐私窗口|password|密码|keychain|钱包|\bbank(ing)?\b|银行|paypal|alipay|支付宝|wells fargo|chase\b|credit card|信用卡|\bssn\b|social security|\b2fa\b|verification code|验证码/i;

/**
 * A window that must not be recorded at all — not its title, and not even that it was open. Banking, password managers
 * and private browsing windows are the defaults; the person adds their own words in settings. The check is deliberately
 * broad: a window skipped by mistake costs a few minutes of a chart, one recorded by mistake costs something that cannot
 * be taken back.
 */
export function isPrivateWindow(app: string, title: string, extra: readonly string[] = []): boolean {
  if (PRIVATE_APPS.test(app.trim())) return true;
  if (PRIVATE_TITLE.test(title)) return true;
  const haystack = `${app} ${title}`.toLowerCase();
  return extra.some((word) => word.trim() && haystack.includes(word.trim().toLowerCase()));
}

// ---------------------------------------------------------------------------------------------------------------------
// Which category

const BY_APP: Array<[RegExp, ActivityCategory]> = [
  [/^(code|code - insiders|cursor|windsurf|devenv|pycharm\d*|idea\d*|clion\d*|webstorm\d*|rider\d*|sublime_text|notepad\+\+|vim|nvim|windowsterminal|wt|powershell|pwsh|cmd|conhost|gitkraken|githubdesktop|docker desktop|postman|android studio|studio64)(\.exe)?$/i, "coding"],
  [/^(matlab|virtuoso|cadence|spectre|ltspice|ltspice\w*|hspice|neurosim|python|pythonw|jupyter\w*|rstudio|mathematica|wolframnb|origin\d*|labview|vivado|quartus|modelsim|questa|klayout|magic|ngspice|comsol|ansys\w*|solidworks)(\.exe)?$/i, "research_tool"],
  [/^(winword|notion|obsidian|typora|onenote|texstudio|texmaker|wps|wpsoffice|et|scrivener|logseq|joplin|evernote|libreoffice|soffice)(\.exe)?$/i, "writing"],
  [/^(acrord32|acrobat|sumatrapdf|foxitreader|foxit\w*|zotero|mendeley\w*|calibre|kindle|readera|nitropdf|pdfxedit|okular)(\.exe)?$/i, "reading"],
  [/^(slack|teams|ms-teams|wechat|weixin|wechatappex|outlook|olk|thunderbird|telegram|discord|whatsapp|line|dingtalk|feishu|lark|qq|tim|mail|spark)(\.exe)?$/i, "communication"],
  [/^(zoom|webex|webexmta|gotomeeting|skype|bluejeans|tencentmeeting|wemeetapp)(\.exe)?$/i, "meeting"],
  [/^(steam|steamwebhelper|epicgameslauncher|spotify|vlc|potplayer|netflix|cloudmusic|qqmusic|bilibili|battle\.net|riotclient\w*|genshin\w*|minecraft\w*|wegame)(\.exe)?$/i, "leisure"],
  [/^(chrome|msedge|firefox|brave|opera|vivaldi|arc|safari|iexplore)(\.exe)?$/i, "browsing"]
];
/** Titles that say more than the app does, mostly for the browser. */
const BY_TITLE: Array<[RegExp, ActivityCategory]> = [
  [/youtube|bilibili|哔哩|netflix|twitch|抖音|tiktok|instagram|reddit|9gag|知乎想法|微博|weibo|斗鱼|虎牙|prime video|disney\+/i, "leisure"],
  [/overleaf|google docs|notion|\.docx?\b|word\b|writing|草稿|论文写作|博客|公众号|编辑器/i, "writing"],
  [/arxiv|scholar\.google|pubmed|ieee xplore|sciencedirect|nature\.com|springer|\.pdf\b|openreview|semantic scholar|researchgate|acm digital/i, "reading"],
  [/github|gitlab|stack overflow|stackoverflow|localhost|jupyter|colab|leetcode|vercel|npm\b|pypi|docs\.python|developer\.mozilla|codeforces/i, "coding"],
  [/gmail|outlook|mail\.|inbox|收件箱|slack|teams\.microsoft|wechat|企业微信|飞书|lark/i, "communication"],
  [/zoom\.us|meet\.google|teams meeting|腾讯会议|webex/i, "meeting"]
];

/**
 * The person's own rules come first, then the title (only when the app is a browser or unknown: a title cannot move
 * Word to "leisure"), then the app. Unknown is `other`, not a guess.
 */
export function classifyWindow(app: string, title: string, rules: readonly ActivityRule[] = []): ActivityCategory {
  const haystack = `${app} ${title}`.toLowerCase();
  for (const rule of rules) if (rule.match.trim() && haystack.includes(rule.match.trim().toLowerCase())) return rule.category;
  const byApp = BY_APP.find(([pattern]) => pattern.test(app.trim()))?.[1];
  if (byApp && byApp !== "browsing") return byApp;
  const byTitle = BY_TITLE.find(([pattern]) => pattern.test(title))?.[1];
  return byTitle ?? byApp ?? "other";
}

// ---------------------------------------------------------------------------------------------------------------------
// Work state

export type WorkStateName = "focused" | "switching" | "in_meeting" | "away" | "leisure" | "mixed" | "unknown";
export type WorkState = {
  state: WorkStateName;
  confidence: "low" | "medium" | "high";
  /** The stretch looked at, in minutes. */
  windowMinutes: number;
  /** Minutes of tracked time in that stretch, by category (and `idle` for time away from the keyboard). */
  minutes: Partial<Record<ActivityCategory | "idle", number>>;
  dominant?: ActivityCategory;
  switches: number;
  inMeeting: boolean;
  /** Why, in the person's words, so a reading is never a bare label. */
  reasons: string[];
};

const MIN = 60_000;

/**
 * Turns the last quarter hour of screen activity, and what the calendar says is happening now, into one of a few plain
 * states. Rules, not a model: every state can be explained by the numbers that produced it, and an unknown stays
 * unknown (under five minutes of tracked time says nothing).
 */
export function inferWorkState(input: {
  segments: ActivitySegment[]; now: string; calendar: Array<{ start: string; end: string }>; windowMinutes?: number;
}): WorkState {
  const windowMinutes = input.windowMinutes ?? 15;
  const to = Date.parse(input.now), from = to - windowMinutes * MIN;
  const inMeeting = input.calendar.some((block) => Date.parse(block.start) <= to && to < Date.parse(block.end));

  const minutes: WorkState["minutes"] = {};
  const live = input.segments.map((segment) => ({ ...segment, s: Math.max(Date.parse(segment.start), from), e: Math.min(Date.parse(segment.end), to) }))
    .filter((segment) => segment.e > segment.s).sort((a, b) => a.s - b.s);
  let tracked = 0, longestRun = 0, run = 0, switches = 0, previousApp: string | undefined;
  for (const segment of live) {
    const length = (segment.e - segment.s) / MIN;
    const key = segment.idle ? "idle" : segment.category;
    minutes[key] = Math.round(((minutes[key] ?? 0) + length) * 10) / 10;
    tracked += length;
    if (segment.idle) { run = 0; previousApp = undefined; continue; }
    if (previousApp !== undefined && segment.app !== previousApp) switches += 1;
    previousApp = segment.app;
    run = PRODUCTIVE.has(segment.category) ? run + length : 0;
    longestRun = Math.max(longestRun, run);
  }
  const idle = minutes.idle ?? 0, active = tracked - idle;
  const dominant = (Object.entries(minutes).filter(([key]) => key !== "idle").sort((a, b) => b[1]! - a[1]!)[0]?.[0]) as ActivityCategory | undefined;
  const base = { windowMinutes, minutes, switches, inMeeting, ...(dominant ? { dominant } : {}) };

  if (inMeeting) return { ...base, state: "in_meeting", confidence: "high", reasons: ["日历上现在有会议；会议里没有键鼠输入是正常的。"] };
  if (tracked < 5) return { ...base, state: "unknown", confidence: "low", reasons: [`最近 ${windowMinutes} 分钟只有 ${Math.round(tracked)} 分钟的记录，不够判断。`] };
  if (idle / tracked >= 0.7) return { ...base, state: "away", confidence: "high", reasons: [`最近 ${windowMinutes} 分钟里有 ${Math.round(idle)} 分钟没有键鼠输入。`] };
  const leisure = minutes.leisure ?? 0;
  if (active > 0 && leisure / active >= 0.6) return { ...base, state: "leisure", confidence: leisure / active >= 0.8 ? "high" : "medium", reasons: [`${Math.round(leisure)} 分钟在${CATEGORY_LABEL.leisure}类应用或页面上。`] };
  if (switches >= 8) return { ...base, state: "switching", confidence: "medium", reasons: [`最近 ${windowMinutes} 分钟切换了 ${switches} 次应用。`] };
  const productive = [...PRODUCTIVE].reduce((sum, category) => sum + (minutes[category] ?? 0), 0);
  if (active > 0 && productive / active >= 0.6) {
    return { ...base, state: "focused", confidence: longestRun >= 10 ? "high" : "medium",
      reasons: [`${Math.round(productive)} 分钟在${CATEGORY_LABEL[dominant ?? "other"]}类工作上，连续最长 ${Math.round(longestRun)} 分钟，切换 ${switches} 次。`] };
  }
  return { ...base, state: "mixed", confidence: "low", reasons: ["工作类和非工作类应用各占一部分，看不出在做哪一种。"] };
}

/** Minutes per category over a set of segments, for what is allowed to leave the machine: no app names, no titles. */
export function categoryMinutesOnly(segments: ActivitySegment[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const segment of segments) {
    const key = segment.idle ? "idle" : segment.category;
    out[key] = Math.round(((out[key] ?? 0) + (Date.parse(segment.end) - Date.parse(segment.start)) / MIN) * 10) / 10;
  }
  return out;
}
