import "server-only";
import {
  AVAILABILITY_PROPOSED_SETTING, AVAILABILITY_SETTING, START_CONFIRMED_SETTING, resolveAvailability,
  type AccessContext, type AvailabilityWindow, type DateExtraction, type StoredLineProfile
} from "@crossline/core";
import { extractBacklog, startConfirmedFor } from "@crossline/db";
import { getStore } from "./crossline";
import { identityLines } from "./lines";

/**
 * The person's one look over what the interview recorded before the app opens (2026-10-19, P2 of the interview redesign): the start
 * standard stands and the extraction has caught up, and the plan will rest on these lines, projects, deadlines and hours. What is wrong
 * is said to the interview in its own box; confirming writes `START_CONFIRMED_SETTING`.
 */
export type StartSummary = {
  lines: Array<{ id: string; label: string; hard: boolean; description: string; goal: string;
    projects: Array<{ name: string; deadline: string }> }>;
  hours: { weekly: number; source: "saved" | "interview" | "stated_hours" | "default"; windows: string[] };
  fixed: { count: number; items: string[] };
};

const WEEKDAY = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const ENERGY: Record<AvailabilityWindow["energy"], string> = { high: "精力高", medium: "精力中", low: "精力低" };
const minutes = (clock: string) => { const [h, m] = clock.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };
/** Days as a run when they are consecutive (周一至周五), else listed. */
function daysText(days: number[]): string {
  const sorted = [...new Set(days)].sort((a, b) => a - b);
  const run = sorted.length > 2 && sorted.every((day, index) => index === 0 || day === sorted[index - 1]! + 1);
  return run ? `${WEEKDAY[sorted[0]!]}至${WEEKDAY[sorted.at(-1)!]}` : sorted.map((day) => WEEKDAY[day]).join("、");
}

export function startSummary(ctx: AccessContext): StartSummary {
  const store = getStore();
  const workspaceId = ctx.workspaceId;
  let profiles: Record<string, StoredLineProfile> = {};
  try { profiles = JSON.parse(store.getSetting(workspaceId, "lines.profiles") ?? "{}") as Record<string, StoredLineProfile>; } catch { /* none */ }
  const facts = store.listProfileFacts(workspaceId);
  const projects = store.listProjects(workspaceId).filter((project) => !project.id.endsWith("-default"));
  const deadlineOf = (projectId: string) => {
    const of = facts.filter((fact) => fact.projectId === projectId && fact.status === "confirmed");
    return of.find((fact) => fact.slot === "deadline")?.value ?? (of.some((fact) => fact.slot === "no_deadline") ? "没有截止"
      : of.find((fact) => fact.slot.startsWith("date_"))?.value ?? "");
  };
  const lines = identityLines(ctx).map((line) => ({
    id: line.id, label: line.label, hard: Boolean(line.hard), description: profiles[line.id]?.description ?? "", goal: line.goals?.[0] ?? "",
    projects: projects.filter((project) => project.identityId === line.id).map((project) => ({ name: project.name, deadline: deadlineOf(project.id) }))
  }));
  const availability = resolveAvailability({ saved: store.getSetting(workspaceId, AVAILABILITY_SETTING),
    proposed: store.getSetting(workspaceId, AVAILABILITY_PROPOSED_SETTING), facts });
  const weekly = availability.windows.reduce((sum, window) => sum + window.days.length * Math.max(0, minutes(window.end) - minutes(window.start)), 0) / 60;
  // Weekly arrangements read from files or replies that nobody turned down: the fixed frame of the week.
  const decided = new Map(store.listEvents(workspaceId, { type: "dates.decided" }).map((event) => [event.entityId,
    event.payload as { superseded?: boolean; included?: string[] }]));
  const recurring = store.listEvents(workspaceId, { type: "dates.extracted" }).flatMap((event) => {
    const decision = decided.get(event.entityId);
    if (decision?.superseded) return [];
    return ((event.payload as unknown as DateExtraction).recurring ?? []).filter((item) => !decision || (decision.included ?? []).includes(item.id));
  });
  return {
    lines,
    hours: { weekly: Math.round(weekly * 10) / 10, source: availability.source,
      windows: availability.windows.map((window) => `${daysText(window.days)} ${window.start}–${window.end}（${ENERGY[window.energy]}）`) },
    fixed: { count: recurring.length, items: recurring.slice(0, 8).map((item) => `${item.title}：${daysText(item.weekdays)}${item.startTime ? ` ${item.startTime}${item.endTime ? `–${item.endTime}` : ""}` : ""}`) }
  };
}

export const startConfirmed = (ctx: AccessContext): boolean => startConfirmedFor(getStore(), ctx.workspaceId);

/** Records the confirmation. Refused while the extraction still owes the main conversation something: the summary would be stale. */
export function confirmStart(ctx: AccessContext): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  const session = store.getLatestOnboardingSession(ctx.workspaceId);
  const backlog = session ? extractBacklog(store, ctx.workspaceId, session.id) : { replies: 0, files: 0 };
  if ((backlog.replies || backlog.files) && !("failing" in backlog && backlog.failing)) return { ok: false, code: "START_STILL_ORGANIZING" };
  const at = new Date().toISOString();
  store.setSetting(ctx.workspaceId, START_CONFIRMED_SETTING, JSON.stringify({ at, via: "person" }));
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `onboarding:start-confirmed:${at}`, type: "onboarding.start_confirmed",
    entityId: ctx.workspaceId, payload: { by: ctx.principalId } });
  return { ok: true };
}
