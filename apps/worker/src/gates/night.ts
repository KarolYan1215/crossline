import { GIT_COMMIT_SEEN_EVENT, NIGHT_HOURS, type DeviceCommit, type GateSubject, type StoredFormRun } from "@crossline/core";
import type { CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { GATE_LIMITS, localHour, previousWeek } from "./context";
import { runGate, type GateResult } from "./run";
import { sentSeenSince } from "./sent-mail";
/* i18n-ignore-start: evidence and context written for a model, not interface text */

/**
 * J6, the night gate (docs/plans/execution-gates-1124.md §四 J6; round 3: hold Crossline's own registration forms, count the person's).
 * In the person's night (`NIGHT_HOURS`, their own rule, in their own zone) a form Crossline is about to submit by itself is judged
 * first; anything not plainly reversible waits at the submit button for the morning. Once a week the person's own outward actions at
 * night (sent mail, commits) are judged for the weekly review; nothing of theirs is held.
 */
export const NIGHT_SKILL = "crossline-gate-night";
export const NIGHT_VERSION = "crossline.gate.night.v1";
/** The reason a held form carries (shown on the run with the other `heldBecause`). */
export const NIGHT_HOLD = "深夜，早上确认"; // i18n-ignore: a reason kept on the run, translated where shown
const DETAIL = { type: "object", additionalProperties: false, required: ["undo"], properties: { undo: { type: "string" } } };

/** Whether `at` is in the person's night. Without a known zone it counts as night: a wrong hold costs hours, a wrong release cannot be undone. */
export const atNight = (at: Date, timeZone: string | undefined) => {
  if (!timeZone) return true;
  const hour = localHour(at, timeZone);
  return hour >= NIGHT_HOURS.from && hour < NIGHT_HOURS.until;
};

/**
 * For the form engine's `night` hook: undefined to let the submission go, or `NIGHT_HOLD`. Outside the night no model runs. A judgement
 * that did not come back in time, or `cannot_judge`, holds too.
 */
export async function nightHoldForForm(deps: { store: CrosslineStore; workspaceId: string; client: CodexRpcBoundary | undefined; cwd: string; timeZone?: string; now?: Date },
  run: StoredFormRun): Promise<string | undefined> {
  const now = deps.now ?? new Date();
  if (!atNight(now, deps.timeZone)) return undefined;
  if (!deps.client) return NIGHT_HOLD;
  const subject: GateSubject = { kind: "form", id: run.id };
  // The checklist's values are already masked for sensitive items (§10.6); only field names and what is shown go to the model.
  const filled = (run.checklist ?? []).slice(0, 30).map((item) => `${item.field}：${item.shown}`);
  const cost = run.opportunity.cost ? `${run.opportunity.cost.amount} ${run.opportunity.cost.currency}（${run.opportunity.cost.quote}）` : "未写明";
  const action = { subject: run.id, kind: "form", at: now.toISOString(),
    what: `报名表：${run.opportunity.title}（主办 ${run.opportunity.organizer}，类型 ${run.opportunity.kind}，网站 ${run.host}）\n费用：${cost}\n同意项：${run.opportunity.consents.join("；")}\n已填：${filled.join("；")}` };
  const results = await runGate({ store: deps.store, workspaceId: deps.workspaceId, client: deps.client, cwd: deps.cwd, gate: "night", skill: NIGHT_SKILL, promptVersion: NIGHT_VERSION,
    input: { version: NIGHT_VERSION, mode: "pending", actions: [action] }, detail: DETAIL, subjects: new Map([[run.id, subject]]),
    round: now.toISOString().slice(0, 16), summary: `pending form ${run.id}`, timeoutMs: GATE_LIMITS.nightFormTimeoutMs, now }).catch(() => []);
  return results[0]?.output.verdict === "reversible" ? undefined : NIGHT_HOLD;
}

/** Last week's review of the person's night actions, done once a week (marked after it ran; a failed run leaves it due). */
const WEEK_DONE = "gates.night.weekDone";
export const nightWeekDue = (store: CrosslineStore, workspaceId: string, now: Date, timeZone?: string) =>
  store.getSetting(workspaceId, WEEK_DONE) !== previousWeek(now, timeZone).start;

/** The person's own outward actions at night last week: sent mail (domains, subject) and commits. */
export function nightActions(store: CrosslineStore, workspaceId: string, now: Date, timeZone?: string) {
  const week = previousWeek(now, timeZone);
  const inWeek = (at: string) => at >= week.from.toISOString() && at < week.until.toISOString() && atNight(new Date(at), timeZone);
  const mail = sentSeenSince(store, workspaceId, week.from.toISOString()).filter((item) => inWeek(item.at)).map((item) => ({
    subject: `mail:${item.accountId}:${item.uid}`, kind: "mail" as const, at: item.at, what: `收件域名 ${item.toDomains.join(", ")}；主题 ${item.subject}` }));
  const commits = store.listEvents(workspaceId, { type: GIT_COMMIT_SEEN_EVENT }).map((event) => ({ event, commit: event.payload as Partial<DeviceCommit> }))
    .filter(({ event, commit }) => inWeek(commit.at ?? event.createdAt)).map(({ event, commit }) => ({
      subject: `commit:${commit.sha ?? event.entityId}`, kind: "commit" as const, at: commit.at ?? event.createdAt,
      what: `仓库 ${commit.repo ?? ""}；${commit.onDefaultBranch ? "在默认分支" : "不在默认分支"}；${commit.subject ?? ""}；文件 ${(commit.files ?? []).slice(0, 10).join(", ")}` }));
  return [...mail, ...commits].sort((a, b) => a.at.localeCompare(b.at)).slice(0, GATE_LIMITS.nightActionsPerWeek);
}

export async function nightWeekPass(deps: { store: CrosslineStore; workspaceId: string; client: CodexRpcBoundary; cwd: string; timeZone?: string; now?: Date }): Promise<GateResult[]> {
  const { store, workspaceId } = deps;
  const now = deps.now ?? new Date();
  const week = previousWeek(now, deps.timeZone);
  const actions = nightActions(store, workspaceId, now, deps.timeZone);
  const subjects = new Map<string, GateSubject>(actions.map((action) => [action.subject, { kind: "action", id: action.subject }]));
  const results = actions.length ? await runGate({ store, workspaceId, client: deps.client, cwd: deps.cwd, gate: "night", skill: NIGHT_SKILL, promptVersion: NIGHT_VERSION,
    input: { version: NIGHT_VERSION, mode: "week", actions }, detail: DETAIL, subjects, round: `week:${week.start}`,
    summary: `night actions ${actions.length} (mail ${actions.filter((item) => item.kind === "mail").length}, commit ${actions.filter((item) => item.kind === "commit").length})`, now }) : [];
  store.setSetting(workspaceId, WEEK_DONE, week.start);
  return results;
}

/* i18n-ignore-end */
