import {
  AGENT_HISTORY_SUMMARY, ATTENTION_CLASSES, GIT_COMMIT_SEEN_EVENT, latestGateJudgements, maskPrivate, taskTitleOf, verdictOf,
  type AgentHistorySummary, type AttentionClass, type DeviceCommit, type GateOutput, type GateSubject
} from "@crossline/core";
import type { CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { privacyOf } from "../git-commits";
import { GATE_LIMITS, gateEventsOf, gateGoal, localDay, pendingFor, previousWeek } from "./context";
import { runGate, type GateResult } from "./run";
import { boardTasks, priorityLabels } from "./tasks";
/* i18n-ignore-start: evidence and context written for a model, not interface text */

/**
 * J3, the weekly attention audit (docs/plans/execution-gates-1124.md §四 J3; round 3: titles go to the model, the model sorts by title).
 * The code gathers last week's measured stretches — timer sessions, Codex / Claude Code sessions by folder, commits, foreground windows
 * by title — and joins overlaps by the Skill's own order (timer, then agent, then screen), so one minute is never counted twice. The
 * model puts every block in a class and judges whether P1 outside gates were crowded out; the hours are summed here from its classes
 * (`computed`), since adding up a few hundred numbers is arithmetic, not judgement.
 */
export const ATTENTION_SKILL = "crossline-gate-attention";
export const ATTENTION_VERSION = "crossline.gate.attention.v1";
const DETAIL = {
  type: "object", additionalProperties: false, required: ["classes", "unclear"],
  properties: {
    classes: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "class", "crossline"],
      properties: { id: { type: "string" }, class: { type: "string", enum: [...ATTENTION_CLASSES] }, crossline: { type: "boolean" } } } },
    unclear: { type: "string" }
  }
};

const MINUTE = 60_000;

export type AttentionBlock = { id: string; start: string; end: string; minutes: number; source: "timer" | "agent" | "commit" | "screen"; text: string };

type Raw = { source: AttentionBlock["source"]; start: number; end: number; key: string; text: string };

/** The minutes (as minute stamps) a stretch covers. */
const minutesOf = (start: number, end: number) => {
  const out: number[] = [];
  for (let at = Math.floor(start / MINUTE) * MINUTE; at < end; at += MINUTE) out.push(at);
  return out;
};

/**
 * Last week's blocks. Overlaps: a minute the timer holds is not counted for an agent session or the screen, and one an agent session
 * holds not for the screen. Stretches of the same thing on the same local day are joined into one block (first start, last end, minutes
 * summed). Timed blocks and commits are each capped on their own (the longest blocks, the latest commits), so neither crowds out the other.
 */
export function attentionBlocks(store: CrosslineStore, workspaceId: string, from: Date, until: Date, timeZone?: string): AttentionBlock[] {
  const lo = from.getTime(), hi = until.getTime();
  const clip = (start: number, end: number) => ({ start: Math.max(start, lo), end: Math.min(end, hi) });
  const privacy = privacyOf(store, workspaceId);
  // Titles reaching the hosted ledger were masked on the device; a ledger on the person's own computer is masked here.
  const mask = (text: string) => maskPrivate(text, privacy.terms, privacy.localOnlyPaths);
  const titles = new Map(boardTasks(store, workspaceId).map((order) => [order.id, taskTitleOf(order)]));
  const raws: Raw[] = [];
  for (const run of store.listExecutions(workspaceId)) {
    if (!run.endedAt) continue;
    const span = clip(Date.parse(run.startedAt), Date.parse(run.endedAt));
    if (span.end <= span.start) continue;
    raws.push({ source: "timer", ...span, key: `timer:${run.workOrderId}`, text: `计时 · ${mask(titles.get(run.workOrderId) ?? run.workOrderId)}` });
  }
  let summary: AgentHistorySummary | null = null;
  try { summary = JSON.parse(store.getSetting(workspaceId, AGENT_HISTORY_SUMMARY) ?? "null") as AgentHistorySummary | null; } catch { summary = null; }
  for (const item of summary?.folderSpans ?? []) {
    const span = clip(Date.parse(item.start), Date.parse(item.end));
    if (span.end <= span.start) continue;
    const tool = item.tool === "claude" ? "Claude Code" : "Codex";
    raws.push({ source: "agent", ...span, key: `agent:${item.tool}:${item.folder}`, text: `${tool} 会话 · 文件夹「${mask(item.folder)}」` });
  }
  for (const entry of store.activityEntriesSince(workspaceId, from.toISOString())) {
    if (entry.idle) continue;
    const span = clip(Date.parse(entry.start), Date.parse(entry.end));
    if (span.end <= span.start) continue;
    const title = mask(entry.title.trim());
    raws.push({ source: "screen", ...span, key: `screen:${entry.app}:${title}`, text: `${entry.app}${title ? ` · ${title}` : ""}` });
  }
  const held = new Set<number>();
  const order: Raw["source"][] = ["timer", "agent", "screen"];
  type Group = { source: Raw["source"]; key: string; day: string; text: string; start: number; end: number; minutes: number };
  const groups = new Map<string, Group>();
  for (const source of order) {
    const taken = new Set<number>();
    for (const raw of raws.filter((item) => item.source === source)) {
      const free = minutesOf(raw.start, raw.end).filter((at) => !held.has(at) && !taken.has(at));
      free.forEach((at) => taken.add(at));
      if (!free.length) continue;
      const day = localDay(new Date(raw.start), timeZone);
      const id = `${raw.key}:${day}`;
      const group = groups.get(id) ?? { source, key: raw.key, day, text: raw.text, start: raw.start, end: raw.end, minutes: 0 };
      group.start = Math.min(group.start, raw.start); group.end = Math.max(group.end, raw.end); group.minutes += free.length;
      groups.set(id, group);
    }
    taken.forEach((at) => held.add(at));
  }
  const timed: AttentionBlock[] = [...groups.values()].map((group) => ({ id: "", start: new Date(group.start).toISOString(), end: new Date(group.end).toISOString(),
    minutes: group.minutes, source: group.source, text: group.text })).sort((a, b) => b.minutes - a.minutes).slice(0, GATE_LIMITS.blocksPerWeek);
  const commits: AttentionBlock[] = store.listEvents(workspaceId, { type: GIT_COMMIT_SEEN_EVENT }).flatMap((event) => {
    const commit = event.payload as Partial<DeviceCommit>;
    const at = Date.parse(commit.at ?? event.createdAt);
    return at >= lo && at < hi ? [{ id: "", start: new Date(at).toISOString(), end: new Date(at).toISOString(), minutes: 0, source: "commit" as const,
      text: `提交 · ${commit.repo ?? ""}${commit.onDefaultBranch ? "（主分支）" : ""}：${commit.subject ?? ""}` }] : [];
  }).slice(-GATE_LIMITS.commitsPerWeek);
  return [...timed, ...commits].sort((a, b) => a.start.localeCompare(b.start)).map((block, index) => ({ ...block, id: `b${index + 1}` }));
}

/** Hours per class from the model's classes (one decimal), and Crossline's own development; a block the model left out counts as `other`. */
export function attentionHours(blocks: readonly AttentionBlock[], output: GateOutput): Record<string, unknown> {
  const classes = new Map(((output.detail as { classes?: Array<{ id: string; class: AttentionClass; crossline: boolean }> } | undefined)?.classes ?? [])
    .map((item) => [item.id, item]));
  const minutes: Record<AttentionClass, number> = { execution: 0, outside_gate: 0, meta: 0, other: 0 };
  let crossline = 0, unclassified = 0;
  for (const block of blocks) {
    const item = classes.get(block.id);
    if (!item) unclassified += block.minutes;
    minutes[item?.class ?? "other"] += block.minutes;
    if (item?.crossline) crossline += block.minutes;
  }
  const hours = (value: number) => Math.round(value / 6) / 10;
  const total = Object.values(minutes).reduce((sum, value) => sum + value, 0);
  return { hours: Object.fromEntries(ATTENTION_CLASSES.map((name) => [name, hours(minutes[name])])), crossline: hours(crossline),
    totalHours: hours(total), metaShare: total ? Math.round((minutes.meta / total) * 100) / 100 : 0, unclassifiedHours: hours(unclassified) };
}

/** Whether last week (in the person's zone) is still to audit. */
export const attentionDue = (store: CrosslineStore, workspaceId: string, now: Date, timeZone?: string) =>
  pendingFor(store, workspaceId, "attention", [previousWeek(now, timeZone).start], now).length > 0;

export async function attentionGatePass(deps: { store: CrosslineStore; workspaceId: string; client: CodexRpcBoundary; cwd: string; timeZone?: string; now?: Date }): Promise<GateResult[]> {
  const { store, workspaceId } = deps;
  const now = deps.now ?? new Date();
  const week = previousWeek(now, deps.timeZone);
  const blocks = attentionBlocks(store, workspaceId, week.from, week.until, deps.timeZone);
  const labels = priorityLabels(store, workspaceId);
  // What the completion gate said of each P1 / outward task by the week's end, the person's overrides applied.
  const completion = latestGateJudgements(gateEventsOf(store, workspaceId).filter((event) => event.createdAt < week.until.toISOString()), "completion");
  const p1 = boardTasks(store, workspaceId).filter((order) => labels.get(order.id)?.p1 || labels.get(order.id)?.external).slice(-GATE_LIMITS.tasksShown).map((order) => {
    const judged = completion.get(`task:${order.id}`);
    return { id: order.id, title: taskTitleOf(order), p1: Boolean(labels.get(order.id)?.p1), outward: Boolean(labels.get(order.id)?.external),
      due: (order.payload as { dueDate?: string } | undefined)?.dueDate ?? "", completion: judged ? verdictOf(judged) : "not_judged" };
  });
  const input = { version: ATTENTION_VERSION, weekStart: week.start, weekEnd: localDay(new Date(week.until.getTime() - 1), deps.timeZone), goal: gateGoal(store, workspaceId, now), p1, blocks };
  const subject: GateSubject = { kind: "week", id: week.start };
  const minutes = (source: AttentionBlock["source"]) => blocks.filter((block) => block.source === source).reduce((sum, block) => sum + block.minutes, 0);
  return runGate({ store, workspaceId, client: deps.client, cwd: deps.cwd, gate: "attention", skill: ATTENTION_SKILL, promptVersion: ATTENTION_VERSION, input,
    detail: DETAIL, subjects: new Map([["week", subject]]), stableKeys: ["goal"], round: week.start,
    summary: `blocks ${blocks.length} (timer ${minutes("timer")} min, agent ${minutes("agent")} min, screen ${minutes("screen")} min, commits ${blocks.filter((block) => block.source === "commit").length}), p1 ${p1.length}`,
    developerInstructions: "Audit the week as the crossline-gate-attention Skill describes: put every block id in `detail.classes`, then judge; return only the requested JSON with one item whose `subject` is `week`.",
    computed: (output) => attentionHours(blocks, output), now });
}

/* i18n-ignore-end */
