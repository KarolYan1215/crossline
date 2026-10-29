import { isAgentCategory, type AgentCategory } from "./agent-dispatch";
import { mentionsExternalAction } from "./external-action";
import { tFor, weekdayShort, type Locale } from "./i18n";
import type { PublicSkillReview, PublicSkillVerdict, ScriptsAllowance, SkillScan } from "./public-skills";

/**
 * A site the workflow reads on the person's behalf (「整理小红书收藏夹」), found by the run that grew it. Only reading: anything that
 * changes the account — moving, deleting, liking, posting — is a step of the person's. `login`: it reads behind the person's own login,
 * which the person does themselves in a browser window Crossline opens with a profile of its own for this workflow.
 */
export type WorkflowAccess = { service: string; site: string; login: boolean; how: string };

/**
 * Grown workflows (`crossline-grown:<id>`, docs/skills-library.md §6): skills the assistant writes itself — with the runtime's own
 * `skill-creator` — once the person has had the same kind of errand done twice, or asks for one in words. A workflow is a skill (SKILL.md,
 * scripts it tested, references) plus a manifest Crossline reads (`workflow.json`): which lines and kind of work it serves, whether it runs
 * when asked or on a schedule, and which of its steps leave the machine. Those steps are always the person's: the run stops before them and
 * hands over what it made, so 「代发布」 means a finished package and one click, never a post made without the person.
 */
export const GROWN_PLUGIN = "crossline-grown";
export const GROWN_LIBRARY_SETTING = "skills.grown";
export const grownSkillFilesKey = (id: string) => `skills.grown.files.${id}`;
export const grownSkillName = (id: string) => `${GROWN_PLUGIN}:${id}`;
/** A grown workflow nobody used or kept for this long goes, like a public skill; one the person kept (`pinned`) stays. */
export const GROWN_SKILL_IDLE_DAYS = 30;
/** Accepted results of one kind of work on one line that make it worth fixing as a workflow. */
export const GROW_AFTER_ACCEPTED = 2;

export const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** The shape of Codex's own `ScheduledTaskSchedule` (app-server protocol v2), so a workflow could be handed to a runtime that schedules natively. */
/**
 * `monthly` (2026-10-29, W-146): on `day` of the month (the month's last day when it has fewer), every `months` months — 1 monthly, 3
 * quarterly, as n8n's Schedule Trigger keeps 「Months Between Triggers」 and 「Trigger at Day of Month」. Before it a 「季度」 request was
 * stored as every Monday and ran thirteen times a quarter.
 */
export type WorkflowSchedule = { type: "daily"; time: string } | { type: "weekdays"; time: string } | { type: "weekly"; days: Weekday[]; time: string }
  | { type: "monthly"; day: number; months: number; time: string };

export type WorkflowManifest = {
  name: string;
  summary: string;
  lines: string[];
  category: AgentCategory;
  /** `on_request`: used when a task of its kind comes up; `schedule`: also started (or reminded about) at its times. */
  trigger: "on_request" | "schedule";
  schedule: WorkflowSchedule | null;
  /** At its time: `run` starts the assistant with this workflow, `remind` only sends `reminder` to the person. */
  action: "run" | "remind";
  reminder: string;
  steps: Array<{ title: string; by: "assistant" | "person"; external: boolean }>;
  inputs: string[];
  outputs: string[];
  /** What it reads on the person's behalf, and the risks of doing so in the person's words; a workflow with any waits for the person's yes. */
  access: WorkflowAccess[];
  risks: string[];
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Whether a step's words say it leaves the machine (sends, uploads, publishes, submits, pays). The shared external-action pattern alone
 * read 「锁定提纲和发布前核对清单」 and 「在任何发送、上传或发布动作前停止」 as publishing (two real grown workflows were refused for
 * them, 2026-10-14), so what is built on those verbs without doing them — 「……前 / 之前」, a pre-publish checklist, a publishing package,
 * 「不发布」 — is taken out first; the verb itself still counts.
 */
export function stepLeavesMachine(title: string): boolean {
  const cleaned = title.replace(/(发布|发送|上传|投稿|提交)[^，。；,.;]{0,14}?(之前|前)/g, "")
    .replace(/(发布|发送|上传|投稿|提交)(包|稿|版|清单|计划|时间|日期|渠道|格式|要求|说明|材料|准备)/g, "")
    .replace(/(不|未|无需|不要|不会|暂不|待|可|准备)(发布|发送|上传|投稿|提交)/g, "").replace(/\b(pre-?publish|publish-ready|draft post|before (sending|posting|publishing))\b/gi, "")
    // The same exemptions in English: the thing to publish (a package, a checklist, a time), and a sentence about *not* sending.
    .replace(/\b(publish|post|send|upload|submi(t|ssion))(ing)? ?(package|draft|checklist|plan|time|date|channel|format|requirements|instructions|materials|prep)\b/gi, "")
    .replace(/\b(do not|don't|does not|doesn't|not|never|no need to|without|ready to|stop before|until you) (publish|post|send|upload|submit)\w*\b/gi, "");
  // The shared pattern has no 「上传」 or 「付款」, and a workflow's step says 「上传到小红书」 as often as 「发布」.
  return mentionsExternalAction(cleaned) || /上传|付款|支付|\b(upload|pay)\b/i.test(cleaned);
}
const READS = /只读|读取|采集|浏览|核验|调研|搜索|检索|查找|下载公开|read|fetch|scrape|search|verify|browse|collect|look up|check|download public/i;
const short = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** Refuses a manifest that cannot be stored or would let a step that leaves the machine run without the person. */
// The problems below go back to the assistant that wrote the manifest: repair messages, not interface text.
/* i18n-ignore-start */
export function validateWorkflowManifest(value: unknown, lineIds: string[]): WorkflowManifest {
  const manifest = value as WorkflowManifest;
  const problems: string[] = [];
  if (!manifest || typeof manifest !== "object") throw Object.assign(new Error("WORKFLOW_MANIFEST_INVALID"), { detail: "workflow.json 不是对象" });
  // The name is only a label: the installed id is made in code (`grownSkillId`), so a name in Chinese is not a reason to refuse the workflow.
  if (!short(manifest.name, 60)) problems.push("name 不能为空");
  if (!short(manifest.summary, 300)) problems.push("summary 须为 1–300 字");
  if (!Array.isArray(manifest.lines) || manifest.lines.some((id) => !lineIds.includes(id))) problems.push(`lines 只能是 ${lineIds.join("、")}`);
  if (!isAgentCategory(manifest.category)) problems.push("category 不是已知的助手工作类别");
  if (manifest.trigger !== "on_request" && manifest.trigger !== "schedule") problems.push("trigger 须为 on_request 或 schedule");
  if (manifest.trigger === "schedule") {
    const schedule = manifest.schedule;
    if (!schedule || !TIME.test(schedule.time ?? "") || !["daily", "weekdays", "weekly", "monthly"].includes(schedule.type)
      || (schedule.type === "weekly" && (!Array.isArray(schedule.days) || !schedule.days.length || schedule.days.some((day) => !WEEKDAYS.includes(day))))
      || (schedule.type === "monthly" && !(monthDayValid(schedule.day) && Number.isInteger(schedule.months) && schedule.months >= 1 && schedule.months <= 12))) {
      problems.push("schedule 须为 daily / weekdays / weekly / monthly，时间 HH:MM，weekly 须列出 MO–SU，monthly 须有 day（1–31）与 months（1–12）");
    }
  } else if (manifest.schedule !== null && manifest.schedule !== undefined) problems.push("trigger 为 on_request 时 schedule 为 null");
  if (manifest.action !== "run" && manifest.action !== "remind") problems.push("action 须为 run 或 remind");
  if (manifest.action === "remind" && !short(manifest.reminder, 200)) problems.push("action 为 remind 时 reminder 须写明提醒的话");
  if (!Array.isArray(manifest.steps) || !manifest.steps.length || manifest.steps.length > 20) problems.push("steps 须为 1–20 步");
  for (const step of Array.isArray(manifest.steps) ? manifest.steps : []) {
    if (!short(step?.title, 120)) { problems.push("每一步须有标题"); break; }
  }
  if (!Array.isArray(manifest.inputs) || !Array.isArray(manifest.outputs)) problems.push("inputs 与 outputs 须为列表");
  // Older manifests carry neither; a workflow that reads an account must say what it reads, how, and what could go wrong.
  const access = Array.isArray(manifest.access) ? manifest.access : [];
  const risks = Array.isArray(manifest.risks) ? manifest.risks.filter((risk) => short(risk, 200)) : [];
  if (access.length > 3) problems.push("access 至多 3 项");
  for (const item of access) {
    if (!short(item?.service, 40) || typeof item.site !== "string" || !/^https:\/\/[^\s/]+/.test(item.site) || typeof item.login !== "boolean" || !short(item.how, 300)) {
      problems.push("access 每项须有 service、https 的 site、login（true/false）与 how"); break;
    }
  }
  if (access.length && !risks.length) problems.push("读取本人账号或网站的工作流须在 risks 里写明风险");
  if (problems.length) throw Object.assign(new Error("WORKFLOW_MANIFEST_INVALID"), { detail: problems.slice(0, 6).join("；") });
  /* i18n-ignore-end */
  // Anything that sends, uploads, publishes, submits or pays is the person's, whatever the manifest says: such a step is handed to the
  // person rather than the workflow refused, since refusing for a sentence about *not* publishing threw good workflows away.
  return { ...manifest, schedule: manifest.trigger === "schedule" ? manifest.schedule : null,
    access: access.map((item) => ({ service: item.service.trim(), site: item.site.trim(), login: item.login, how: item.how.trim() })), risks: risks.slice(0, 8),
    steps: manifest.steps.map((step) => {
      // Reading a page is not leaving the machine: the first account-reading workflow marked 「低频只读采集」 and 「联网核验」 external,
      // which would have handed its own reading to the person (2026-10-14). The words decide when they plainly only read.
      const onlyReads = READS.test(step.title) && !stepLeavesMachine(step.title);
      const external = (Boolean(step.external) && !onlyReads) || stepLeavesMachine(step.title);
      return { title: step.title, by: external || step.by === "person" ? "person" : "assistant", external };
    }) };
}

/** The steps a manifest handed to the person because they leave the machine, though it gave them to the assistant (said when installed). */
export const reassignedSteps = (raw: { steps?: Array<{ title?: string; by?: string }> }, manifest: WorkflowManifest) =>
  manifest.steps.filter((step, index) => step.external && raw.steps?.[index]?.by !== "person").map((step) => step.title);

const WEEKDAY_OF: Record<string, Weekday> = { Mon: "MO", Tue: "TU", Wed: "WE", Thu: "TH", Fri: "FR", Sat: "SA", Sun: "SU" };
/** The person's wall clock: day of week and `HH:MM`, and the date, in their own zone. */
function wallClock(at: Date, zone: string): { day: string; weekday: Weekday; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: WEEKDAY_OF[parts.weekday!] ?? "MO", time: `${parts.hour}:${parts.minute}` };
}
const monthDayValid = (day: unknown): boolean => Number.isInteger(day) && (day as number) >= 1 && (day as number) <= 31;
const monthIndex = (day: string) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
/** A monthly schedule's day in this month: its own day, or the month's last when the month is shorter (31 → 30 in November). */
const monthlyDay = (day: number, localDay: string) => Math.min(day, new Date(Date.UTC(Number(localDay.slice(0, 4)), Number(localDay.slice(5, 7)), 0)).getUTCDate());
const runsOn = (schedule: WorkflowSchedule, clock: { day: string; weekday: Weekday }, lastDay: string | undefined) => {
  if (schedule.type === "daily") return true;
  if (schedule.type === "weekdays") return !["SA", "SU"].includes(clock.weekday);
  if (schedule.type === "weekly") return schedule.days.includes(clock.weekday);
  return Number(clock.day.slice(8, 10)) === monthlyDay(schedule.day, clock.day)
    && (!lastDay || monthIndex(clock.day) - monthIndex(lastDay) >= schedule.months);
};

/**
 * Reads a monthly schedule out of the designer's flat `days` (「MONTHLY:15」, 「QUARTERLY:1」, 「MONTHS:6:1」, or 每月 / 每季度 with a day).
 * Undefined when the text names no months.
 */
export function monthlyFromDays(days: string, time: string): WorkflowSchedule | undefined {
  const text = days.trim().toUpperCase();
  const match = /^(?:(MONTHLY|每月|每个月)|(QUARTERLY|每季度?|每个季度)|MONTHS[:：]?(\d{1,2}))(?:[:：\s]*(\d{1,2}))?/.exec(text);
  if (!match) return undefined;
  const months = match[1] ? 1 : match[2] ? 3 : Math.min(12, Math.max(1, Number(match[3])));
  const day = Math.min(31, Math.max(1, Number(match[4] ?? 1)));
  return { type: "monthly", day, months, time };
}
/** The flat `days` a monthly schedule is written back as, for a request that changes another part of it. */
export const monthlyDays = (schedule: Extract<WorkflowSchedule, { type: "monthly" }>) =>
  schedule.months === 1 ? `MONTHLY:${schedule.day}` : schedule.months === 3 ? `QUARTERLY:${schedule.day}` : `MONTHS:${schedule.months}:${schedule.day}`;

/**
 * Whether a scheduled workflow is due now: today (in the person's zone) is one of its days, its time has passed, it has not run today,
 * and the time is under three hours ago — a worker that was off at the time does not fire the morning's reminder in the evening. A run
 * held at its time because the assistant was busy (`heldSince`, today) stays due for the rest of the day.
 */
export function workflowDue(schedule: WorkflowSchedule, lastRunAt: string | undefined, now: Date, zone: string, heldSince?: string): boolean {
  const clock = wallClock(now, zone);
  const lastDay = lastRunAt ? wallClock(new Date(lastRunAt), zone).day : undefined;
  if (lastDay === clock.day) return false;
  if (!runsOn(schedule, clock, lastDay) || clock.time < schedule.time) return false;
  // Held at its time because the assistant was busy: still due today, however late.
  if (heldSince && wallClock(new Date(heldSince), zone).day === clock.day) return true;
  const [hour, minute] = schedule.time.split(":").map(Number);
  const [nowHour, nowMinute] = clock.time.split(":").map(Number);
  return (nowHour! * 60 + nowMinute!) - (hour! * 60 + minute!) < 180;
}

const DAY_NUMBER: Record<Weekday, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 0 };
/** 「每周一、五 09:00」 / "Every Mon, Fri 09:00"; 「按需」 / "On request". */
export const scheduleLabel = (schedule: WorkflowSchedule | null, locale?: Locale): string => {
  const t = tFor(locale);
  if (!schedule) return t("按需");
  if (schedule.type === "daily") return t("每天 {{time}}", { time: schedule.time });
  if (schedule.type === "weekdays") return t("工作日 {{time}}", { time: schedule.time });
  if (schedule.type === "monthly") return schedule.months === 1 ? t("每月 {{day}} 日 {{time}}", { day: schedule.day, time: schedule.time })
    : schedule.months === 3 ? t("每季度 {{day}} 日 {{time}}", { day: schedule.day, time: schedule.time })
    : t("每 {{months}} 个月 {{day}} 日 {{time}}", { months: schedule.months, day: schedule.day, time: schedule.time });
  const days = locale === "en" ? schedule.days.map((day) => weekdayShort(locale, DAY_NUMBER[day])).join(", ")
    : schedule.days.map((day) => weekdayShort(locale, DAY_NUMBER[day]).slice(1)).join("、");
  return t("每周{{days}} {{time}}", { days, time: schedule.time });
};

/** Where a grown workflow came from: two accepted results of one kind, the person's words, or a task the library had nothing for. */
export type WorkflowOrigin = { kind: "repeated"; taskIds: string[] } | { kind: "asked"; text: string; requestId: string };

export type GrownSkillRecord = {
  id: string; kind: "grown"; name: string; description: string;
  lines: string[]; category: AgentCategory;
  manifest: WorkflowManifest;
  origin: WorkflowOrigin;
  /** The assistant run that wrote it (its audit is in the ledger like any other run's). */
  taskId: string;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  scan: SkillScan;
  review: PublicSkillReview & { final: PublicSkillVerdict };
  /** `off`: kept but not used or scheduled; `needs_consent`: reads an account or site, and waits for the person to accept its risks. */
  status: "active" | "off" | "needs_consent";
  /** When the person accepted the risks of what it reads, and when they last logged in to each service it reads behind a login. */
  consentedAt?: string;
  logins?: Record<string, string>;
  /** The browser each login was made in: the profile it wrote is read by that same browser. */
  loginBrowsers?: Record<string, string>;
  /** Kept by the person: never removed for being idle. */
  pinned: boolean;
  scriptsAllowed?: ScriptsAllowance;
  createdAt: string; updatedAt: string; lastUsedAt: string;
  lastRunAt?: string;
  /**
   * The last run that read items off the sites it reads (docs/skills-library.md §8): its output folder, given to the next run read-only
   * so it organises only what is new, the pages that showed the items (with the tab clicked), and how many there were.
   */
  lastRead?: { at: string; taskId: string; directory: string; items: number; pages: Array<{ url: string; click?: string }> };
  /** Its time came while the assistant was busy: tried again at the next ticks of that day, past the usual three hours. */
  heldSince?: string;
  /**
   * Which version is in force (1 when installed) and when Crossline last revised it from what its runs and the person said
   * (docs/skills-library.md 「工作流自我改进」); the versions it replaced are kept under `grownVersionsKey`.
   */
  version?: number;
  improvedAt?: string;
  /** Merged into another workflow that does the same job (workflow-merge.ts): switched off, with the status it had, until 撤销合并. */
  mergedInto?: { id: string; at: string; why: string; status: "active" | "off" | "needs_consent" };
};

/**
 * A reader's page waiting for the person's verification (the favourites job, workflow-smith.ts): written while it waits, removed when it
 * ends, read by the 小帮手 on every page (apps/web/lib/person-calls.ts) so the dialog opens wherever the person is.
 */
export const VERIFY_PENDING_SETTING = "remote.verify.pending";

/** The versions of a grown workflow a revision replaced, newest last (at most `GROWN_VERSIONS_KEPT`). */
export const grownVersionsKey = (id: string) => `skills.grown.versions.${id}`;
export const GROWN_VERSIONS_KEPT = 10;
/** What the person says a workflow should do differently (Skill 库 「让它改进」): the strongest reason to revise it. */
export const WORKFLOW_FEEDBACK_EVENT = "skill.grown.feedback";
export type GrownSkillVersion = {
  version: number; at: string;
  /** Why it was replaced (the revision's own note of what changed). */
  replacedBecause: string;
  manifest: WorkflowManifest; files: Array<{ path: string; text: string }>;
  scan: SkillScan; review: PublicSkillReview & { final: PublicSkillVerdict };
};

/**
 * Whether a revision reaches further than the version the person agreed to: a site it did not read, a login it did not use, a risk it
 * did not state, or a step leaving the machine that was not there. Such a revision waits for the person's consent again.
 */
export function revisionWidens(before: WorkflowManifest, after: WorkflowManifest): boolean {
  const sites = new Set((before.access ?? []).map((item) => `${item.site}|${item.login}`));
  const risks = new Set(before.risks ?? []);
  const external = new Set(before.steps.filter((step) => step.external).map((step) => step.title));
  return (after.access ?? []).some((item) => !sites.has(`${item.site}|${item.login}`))
    || (after.risks ?? []).some((risk) => !risks.has(risk))
    || after.steps.some((step) => step.external && !external.has(step.title));
}

export function readGrownLibrary(raw: string | undefined): GrownSkillRecord[] {
  if (!raw) return [];
  try { const parsed = JSON.parse(raw) as GrownSkillRecord[]; return Array.isArray(parsed) ? parsed.filter((item) => item && item.kind === "grown") : []; }
  catch { return []; }
}

/** A grown skill's id: `flow-` and its manifest name, unique among the ids taken. */
export function grownSkillId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = `flow-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "workflow"}`;
  let id = base, n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  return id;
}

/** A grown record stored before `access` existed reads as one that reads nothing. */
export const workflowAccess = (record: { manifest: Partial<Pick<WorkflowManifest, "access" | "risks">> }) =>
  ({ access: record.manifest.access ?? [], risks: record.manifest.risks ?? [] });

/**
 * The scan of a workflow that declares what it reads: reaching the network is what it was written to do, so a `net` finding is kept on
 * the record but no longer caps it to text; anything else (deleting, leaving its folder, secrets, the system, downloading and running) still does.
 */
export function scanForDeclaredAccess(scan: SkillScan, declared: boolean): SkillScan {
  if (!declared) return scan;
  return { ...scan, risk: scan.findings.some((finding) => !["net", "injection", "hidden.text"].includes(finding.rule)) ? "high" : "low" };
}

/** The folder name of a service's browser profile: ASCII from its site's host, so 「小红书」 and `https://www.xiaohongshu.com` share one. */
export const accessProfileSlug = (access: Pick<WorkflowAccess, "site" | "service">): string => {
  const host = /^https:\/\/([^/:?#]+)/i.exec(access.site)?.[1]?.toLowerCase().replace(/^www\./, "") ?? "";
  return (host || access.service).replace(/[^a-z0-9.-]+/gi, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "site";
};
