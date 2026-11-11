import "server-only";
import { createHash } from "node:crypto";
import { anyWritePathOn, CALENDAR_PUBLISH_FAILURE, requiredApproval, type AccessContext } from "@crossline/core";
import { getStore } from "./crossline";
import { blocksToPublish } from "./calendar-publish";
import { calendarItems, imipFrom, imipPass, recordPathFailure, writePaths, type CalendarItem } from "./calendar-write";
import { CodexSupervisorRequestError, requestCodexSupervisor } from "./codex-runtime";
import { publishFixedEvents } from "./fixed-events";
import { onOptimalWritten } from "./optimal-schedule";
import { yieldToRequests } from "./yield";

const LAST_HASH = "calendar.autopublish.hash";
/** How often the web process looks for a changed schedule to publish. */
export const AUTO_PUBLISH_INTERVAL_MS = 10 * 60_000;

/** A system job's context for one workspace: its owner, marked as not a person's request. */
export function systemContext(workspaceId: string, ownerId: string, now: Date): AccessContext {
  return { principalId: ownerId, workspaceId, role: "owner", identity: { provider: "credential", issuer: "crossline-system", subject: ownerId },
    authMethod: "system-job", requestId: `auto-publish:${now.toISOString()}` };
}

/**
 * Keeps the Crossline calendar in step with the plan without a click — the person's decision
 * (`write_focus_block` is now `automatic`), and only the boundary of what is written moved: still only the
 * calendar named Crossline, only events this app made and the person has not changed, deletes only in the
 * future, previews never. A run with nothing new to write sends nothing (the blocks' hash is compared first).
 */
function recordFailure(workspaceId: string, failure: { code: string; message: string } | undefined, now: Date): void {
  try { getStore().setSetting(workspaceId, CALENDAR_PUBLISH_FAILURE, failure ? JSON.stringify({ ...failure, at: now.toISOString() }) : ""); }
  catch { /* the publish result is what matters */ }
}

/** Forgets the last published hash, so the next pass publishes even though nothing changed (the person fixed the login). */
export function forgetPublishedHash(workspaceId: string): void {
  getStore().setSetting(workspaceId, LAST_HASH, "");
}

export async function autoPublishPass(now = new Date()): Promise<Array<{ workspaceId: string; state: string }>> {
  if (requiredApproval("write_focus_block") !== "automatic") return [];
  const outcomes: Array<{ workspaceId: string; state: string }> = [];
  for (const workspace of getStore().listWorkspaces()) {
    await yieldToRequests();
    const state = await publishWorkspace(workspace.id, now);
    if (state) outcomes.push({ workspaceId: workspace.id, state });
  }
  return outcomes;
}

/**
 * One workspace's publish; undefined when it has no writer account. `pending`: the optimal plan is still being solved. A call while
 * one is running joins it and asks for one more pass after it, with the plan as it is then: the ten-minute pass, the optimal plan
 * landing and an answered ask often come together, and each is a full read and write of the calendar (the worker also runs them one
 * at a time, which is what keeps them from reading each other's writes as the person's).
 */
const running = new Map<string, Promise<string | undefined>>();
const again = new Set<string>();
export function publishWorkspace(workspaceId: string, now = new Date()): Promise<string | undefined> {
  const current = running.get(workspaceId);
  if (current) { again.add(workspaceId); return current; }
  const run = publishOnce(workspaceId, now).finally(() => {
    running.delete(workspaceId);
    if (again.delete(workspaceId)) void publishWorkspace(workspaceId).catch(() => undefined);
  });
  running.set(workspaceId, run);
  return run;
}

/**
 * Every calendar path that is on (core `calendar-write.ts`, the owner's decision of 2026-11-10). The feed (a) has nothing to push: a
 * calendar app reads it. Invitations (b) and Google (c) get the same items; Microsoft (d) keeps its own flow below. Each path's failure is
 * kept apart, so one that fails never stops another. Returns the Microsoft path's state when it is on, else the first other path's.
 */
async function publishOnce(workspaceId: string, now: Date): Promise<string | undefined> {
  const store = getStore();
  const ownerId = store.getWorkspaceOwnerId(workspaceId);
  const paths = writePaths(workspaceId);
  if (!ownerId || !anyWritePathOn(paths)) return undefined;
  const ctx = systemContext(workspaceId, ownerId, now);
  const states: string[] = [];
  if (paths.imip || paths.google) {
    const { items, pending } = await calendarItems(ctx, now, { waitForOptimal: true }).catch(() => ({ items: [] as CalendarItem[], pending: true as const }));
    if (pending) states.push("pending");
    else {
      if (paths.imip) states.push(await invitePath(ctx, items, now));
      if (paths.google) states.push(await googlePath(ctx, items, now));
    }
  }
  const graph = paths.graph && store.getSetting(workspaceId, "calendar.write.account") ? await graphPath(ctx, now) : undefined;
  return graph ?? states[0] ?? "unchanged";
}

async function invitePath(ctx: AccessContext, items: CalendarItem[], now: Date): Promise<string> {
  // Loaded only when invitations are on: the auth module is heavy, and every page that reads asks imports this file.
  const { appInviteSender } = await import("./auth");
  const send = appInviteSender(imipFrom());
  if (!send) { recordPathFailure(ctx.workspaceId, "imip", { code: "CALENDAR_IMIP_NO_MAIL", message: "" }, now); return "failed"; }
  try {
    const result = await imipPass(ctx, items, send, now);
    recordPathFailure(ctx.workspaceId, "imip", undefined, now);
    return result.sent || result.cancelled ? "published" : "unchanged";
  } catch (error) {
    recordPathFailure(ctx.workspaceId, "imip", { code: (error as { code?: string }).code ?? "CALENDAR_IMIP_FAILED", message: error instanceof Error ? error.message.slice(0, 200) : "" }, now);
    return "failed";
  }
}

const GOOGLE_HASH = "calendar.google.hash";
/** The Google path is the worker's: it holds the Codex runtime whose ChatGPT login carries the connector. Sent only when something changed. */
async function googlePath(ctx: AccessContext, items: CalendarItem[], now: Date): Promise<string> {
  const store = getStore();
  const blocks = items.map((item) => ({ id: item.id, title: item.title, start: item.start, end: item.end, reminderMinutes: item.reminderMinutes,
    ...(item.series ? { recurrence: item.series.graph } : {}) }));
  const hash = createHash("sha256").update(JSON.stringify(blocks)).digest("hex").slice(0, 32);
  if (store.getSetting(ctx.workspaceId, GOOGLE_HASH) === hash) return "unchanged";
  try {
    const result = await requestCodexSupervisor<{ state?: string; code?: string; message?: string }>(ctx, "/v1/calendar/publish", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocks, path: "google" }), signal: AbortSignal.timeout(300_000) });
    if (result.state === "published") store.setSetting(ctx.workspaceId, GOOGLE_HASH, hash);
    recordPathFailure(ctx.workspaceId, "google", result.state === "published" ? undefined : { code: result.code ?? "CALENDAR_GOOGLE_FAILED", message: result.message ?? "" }, now);
    return result.state ?? "unknown";
  } catch (error) {
    recordPathFailure(ctx.workspaceId, "google", error instanceof CodexSupervisorRequestError ? { code: error.blocker.code, message: error.blocker.message ?? "" }
      : { code: "CALENDAR_GOOGLE_FAILED", message: error instanceof Error ? error.message.slice(0, 200) : "" }, now);
    return "failed";
  }
}

async function graphPath(ctx: AccessContext, now: Date): Promise<string> {
  const store = getStore();
  const workspaceId = ctx.workspaceId;
  // The person's fixed events are theirs, not the plan's: published as their own scope.
  await publishFixedEvents(ctx, now).catch(() => undefined);
  try {
    const { blocks, pending } = await blocksToPublish(ctx, now, { waitForOptimal: true });
    if (pending) return "pending";
    const hash = createHash("sha256").update(JSON.stringify(blocks)).digest("hex").slice(0, 32);
    if (store.getSetting(workspaceId, LAST_HASH) === hash) return "unchanged";
    const result = await requestCodexSupervisor<{ state?: string; code?: string; message?: string }>(ctx, "/v1/calendar/publish", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blocks }), signal: AbortSignal.timeout(120_000) });
    if (result.state === "published") store.setSetting(workspaceId, LAST_HASH, hash);
    // A failure is kept for the person (an ask with what to do), not only returned to a timer that discards it.
    recordFailure(workspaceId, result.state === "published" ? undefined : { code: result.code ?? "CALENDAR_PUBLISH_FAILED", message: result.message ?? "" }, now);
    return result.state ?? "unknown";
  } catch (error) {
    recordFailure(workspaceId, error instanceof CodexSupervisorRequestError ? { code: error.blocker.code, message: error.blocker.message ?? "" }
      : { code: "CALENDAR_PUBLISH_FAILED", message: error instanceof Error ? error.message.slice(0, 200) : "" }, now);
    return "failed";
  }
}

/** The optimal plan is written to the calendar as soon as it is solved, not at the next ten-minute pass. */
export function publishNow(workspaceId: string): Promise<string | undefined> {
  if (requiredApproval("write_focus_block") !== "automatic") return Promise.resolve(undefined);
  return publishWorkspace(workspaceId).catch(() => "failed");
}
onOptimalWritten((workspaceId) => { if (process.env.CROSSLINE_AUTO_PUBLISH !== "off") void publishNow(workspaceId); });
