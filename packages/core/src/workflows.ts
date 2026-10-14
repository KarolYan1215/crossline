import { isAgentCategory, type AgentCategory } from "./agent-dispatch";
import { mentionsExternalAction } from "./external-action";
import type { PublicSkillReview, PublicSkillVerdict, SkillScan } from "./public-skills";

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
export type WorkflowSchedule = { type: "daily"; time: string } | { type: "weekdays"; time: string } | { type: "weekly"; days: Weekday[]; time: string };

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
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const short = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** Refuses a manifest that cannot be stored or would let a step that leaves the machine run without the person. */
export function validateWorkflowManifest(value: unknown, lineIds: string[]): WorkflowManifest {
  const manifest = value as WorkflowManifest;
  const problems: string[] = [];
  if (!manifest || typeof manifest !== "object") throw Object.assign(new Error("WORKFLOW_MANIFEST_INVALID"), { detail: "workflow.json 不是对象" });
  if (!short(manifest.name, 60) || !/^[a-z0-9][a-z0-9-]*$/.test(manifest.name)) problems.push("name 须为小写字母、数字和连字符");
  if (!short(manifest.summary, 300)) problems.push("summary 须为 1–300 字");
  if (!Array.isArray(manifest.lines) || manifest.lines.some((id) => !lineIds.includes(id))) problems.push(`lines 只能是 ${lineIds.join("、")}`);
  if (!isAgentCategory(manifest.category)) problems.push("category 不是已知的助手工作类别");
  if (manifest.trigger !== "on_request" && manifest.trigger !== "schedule") problems.push("trigger 须为 on_request 或 schedule");
  if (manifest.trigger === "schedule") {
    const schedule = manifest.schedule;
    if (!schedule || !TIME.test(schedule.time ?? "") || !["daily", "weekdays", "weekly"].includes(schedule.type)
      || (schedule.type === "weekly" && (!Array.isArray(schedule.days) || !schedule.days.length || schedule.days.some((day) => !WEEKDAYS.includes(day))))) {
      problems.push("schedule 须为 daily / weekdays / weekly，时间 HH:MM，weekly 须列出 MO–SU");
    }
  } else if (manifest.schedule !== null && manifest.schedule !== undefined) problems.push("trigger 为 on_request 时 schedule 为 null");
  if (manifest.action !== "run" && manifest.action !== "remind") problems.push("action 须为 run 或 remind");
  if (manifest.action === "remind" && !short(manifest.reminder, 200)) problems.push("action 为 remind 时 reminder 须写明提醒的话");
  if (!Array.isArray(manifest.steps) || !manifest.steps.length || manifest.steps.length > 20) problems.push("steps 须为 1–20 步");
  for (const step of Array.isArray(manifest.steps) ? manifest.steps : []) {
    if (!short(step?.title, 120)) { problems.push("每一步须有标题"); break; }
    // Anything that sends, publishes, submits or pays is the person's, whatever the manifest says about it.
    if ((step.external || mentionsExternalAction(step.title)) && step.by !== "person") problems.push(`「${step.title}」会离开本机，须由本人完成（by: person, external: true）`);
  }
  if (!Array.isArray(manifest.inputs) || !Array.isArray(manifest.outputs)) problems.push("inputs 与 outputs 须为列表");
  if (problems.length) throw Object.assign(new Error("WORKFLOW_MANIFEST_INVALID"), { detail: problems.slice(0, 6).join("；") });
  return { ...manifest, schedule: manifest.trigger === "schedule" ? manifest.schedule : null,
    steps: manifest.steps.map((step) => ({ title: step.title, by: step.by === "person" ? "person" : "assistant", external: Boolean(step.external) || mentionsExternalAction(step.title) })) };
}

const WEEKDAY_OF: Record<string, Weekday> = { Mon: "MO", Tue: "TU", Wed: "WE", Thu: "TH", Fri: "FR", Sat: "SA", Sun: "SU" };
/** The person's wall clock: day of week and `HH:MM`, and the date, in their own zone. */
function wallClock(at: Date, zone: string): { day: string; weekday: Weekday; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, weekday: WEEKDAY_OF[parts.weekday!] ?? "MO", time: `${parts.hour}:${parts.minute}` };
}
const runsOn = (schedule: WorkflowSchedule, weekday: Weekday) =>
  schedule.type === "daily" || (schedule.type === "weekdays" ? !["SA", "SU"].includes(weekday) : schedule.days.includes(weekday));

/**
 * Whether a scheduled workflow is due now: today (in the person's zone) is one of its days, its time has passed, it has not run today,
 * and the time is under three hours ago — a worker that was off at the time does not fire the morning's reminder in the evening.
 */
export function workflowDue(schedule: WorkflowSchedule, lastRunAt: string | undefined, now: Date, zone: string): boolean {
  const clock = wallClock(now, zone);
  if (!runsOn(schedule, clock.weekday) || clock.time < schedule.time) return false;
  if (lastRunAt && wallClock(new Date(lastRunAt), zone).day === clock.day) return false;
  const [hour, minute] = schedule.time.split(":").map(Number);
  const [nowHour, nowMinute] = clock.time.split(":").map(Number);
  return (nowHour! * 60 + nowMinute!) - (hour! * 60 + minute!) < 180;
}

const DAY_LABEL: Record<Weekday, string> = { MO: "一", TU: "二", WE: "三", TH: "四", FR: "五", SA: "六", SU: "日" };
export const scheduleLabel = (schedule: WorkflowSchedule | null): string => !schedule ? "按需"
  : schedule.type === "daily" ? `每天 ${schedule.time}` : schedule.type === "weekdays" ? `工作日 ${schedule.time}`
  : `每周${schedule.days.map((day) => DAY_LABEL[day]).join("、")} ${schedule.time}`;

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
  /** `off`: kept but not used or scheduled. */
  status: "active" | "off";
  /** Kept by the person: never removed for being idle. */
  pinned: boolean;
  createdAt: string; updatedAt: string; lastUsedAt: string;
  lastRunAt?: string;
};

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
