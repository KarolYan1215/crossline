import { ACTIVITY_RULES, STEP_ROLES, TIME_ATTRIBUTION_SCHEMA, TIME_DRAFT_DAYS, TIME_DRAFT_DECISIONS, TIME_DRAFTS, draftTimeEntries, instantInZone, validateTimeAttribution,
  zonedParts, type ActivityRule, type DraftBlock, type DraftDecision, type TimeAttribution, type TimeDraft } from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { ACTIVITY_DETAIL_CONSENT } from "./activity-recorder";
import { identityLines } from "./lines";

export const TIME_ATTRIBUTOR = "crossline:crossline-time-attributor";
const DAY = 86_400_000;
/** Open tasks are the ones a stretch of work can still be for. */
const OPEN = new Set(["approved", "preparing", "ready_for_human", "active"]);
/** At most this many stretches go to the model in one run; the rest wait for the next. */
const BATCH = 20;

const json = <T>(raw: string | null | undefined, fallback: T): T => { try { return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; } };
const zoneOf = (store: CrosslineStore, workspaceId: string) =>
  json<{ timeZone?: string } | null>(store.getSetting(workspaceId, "schedule.preferences"), null)?.timeZone || process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago";
const isRule = (item: unknown): item is ActivityRule => typeof item === "object" && item !== null
  && typeof (item as ActivityRule).match === "string" && typeof (item as ActivityRule).category === "string";

/** The drafts as stored, unreadable as none. */
export const readTimeDrafts = (store: CrosslineStore, workspaceId: string): TimeDraft[] => json<TimeDraft[]>(store.getSetting(workspaceId, TIME_DRAFTS), []);

/** The blocks the nudge pass saw under way on each day from `since` to `now` (`nudge.blocks:<day>`), as instants with their step's kind. */
function seenBlocks(store: CrosslineStore, workspaceId: string, since: number, now: Date, zone: string): DraftBlock[] {
  const out: DraftBlock[] = [];
  for (let at = since; at <= now.getTime() + DAY; at += DAY) {
    const day = zonedParts(at, zone).day;
    const seen = json<Record<string, { orderId?: string; stepId?: string; start?: string; end?: string; began?: boolean }>>(store.getSetting(workspaceId, `nudge.blocks:${day}`), {});
    for (const block of Object.values(seen)) {
      if (!block.began || !block.orderId || !block.start || !block.end) continue;
      const role = block.stepId ? store.getStepPlan(workspaceId, block.orderId)?.steps.find((step) => step.id === block.stepId)?.role : undefined;
      out.push({ orderId: block.orderId, stepId: block.stepId ?? "", ...(role ? { role } : {}),
        start: new Date(instantInZone(day, block.start, zone)).toISOString(), end: new Date(instantInZone(day, block.end, zone)).toISOString() });
    }
  }
  return out;
}

/**
 * 拟计时, the worker's half (docs/plans/2026-11-11-walkthrough-decisions.md §1): under the 「应用与窗口」 consent only, drafts the last
 * fourteen days' untimed work from the kept segments (`draftTimeEntries`: the person's rules, then the blocks seen under way), then asks
 * the attribution model about the stretches nothing placed — their app, category and window titles, with the open tasks and their open
 * steps (the owner's decision of 2026-11-11: titles may go to the model). The model only proposes; a task or step that is not open is
 * dropped. Each unattributed stretch is asked about once. Drafts older than fourteen days are dropped; without the consent all are.
 * This writes `TIME_DRAFTS` only — the person's decisions are the web's (`TIME_DRAFT_DECISIONS`).
 */
export function createTimeDraftPass(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function pass(now = new Date()): Promise<{ drafted: number; attributed: number; blocked?: string }> {
    if (store.getSetting(workspaceId, ACTIVITY_DETAIL_CONSENT) !== "granted") {
      if (store.getSetting(workspaceId, TIME_DRAFTS) !== undefined) store.deleteSetting(workspaceId, TIME_DRAFTS);
      return { drafted: 0, attributed: 0 };
    }
    const zone = zoneOf(store, workspaceId);
    const since = now.getTime() - TIME_DRAFT_DAYS * DAY;
    const kept = readTimeDrafts(store, workspaceId).filter((draft) => Date.parse(draft.end) >= since);
    const segments = store.activityEntriesSince(workspaceId, new Date(since).toISOString());
    const rules = json<unknown[]>(store.getSetting(workspaceId, ACTIVITY_RULES), []).filter(isRule);
    // Timed time is never drafted: every session, a running one to now.
    const timed = store.listExecutions(workspaceId).filter((execution) => Date.parse(execution.endedAt ?? now.toISOString()) >= since)
      .map((execution) => ({ start: execution.startedAt, end: execution.endedAt ?? now.toISOString() }));
    const found = draftTimeEntries({ segments, rules, blocks: seenBlocks(store, workspaceId, since, now, zone),
      excluded: [...timed, ...kept.map((draft) => ({ start: draft.start, end: draft.end }))], now: now.toISOString() });
    const titles = new Map<string, string[]>();
    const fresh: TimeDraft[] = found.map(({ draft, titles: seen }) => {
      const id = `draft:${draft.start}`;
      titles.set(id, seen);
      return { ...draft, id, createdAt: now.toISOString() };
    });
    let drafts = [...kept, ...fresh].sort((a, b) => a.start.localeCompare(b.start));

    let attributed = 0, blocked: string | undefined;
    // Every stretch nothing placed and the model has not seen, a kept one too (drafted while no model was at hand), titles read again.
    const ask = drafts.filter((draft) => draft.basis === "none" && !draft.asked).slice(0, BATCH);
    for (const draft of ask) if (!titles.has(draft.id)) {
      const from = Date.parse(draft.start), to = Date.parse(draft.end), byTitle = new Map<string, number>();
      for (const segment of segments) {
        const overlap = Math.min(to, Date.parse(segment.end)) - Math.max(from, Date.parse(segment.start));
        if (overlap > 0 && !segment.idle && segment.title.trim()) byTitle.set(segment.title.trim(), (byTitle.get(segment.title.trim()) ?? 0) + overlap);
      }
      titles.set(draft.id, [...byTitle.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([title]) => title.slice(0, 160)));
    }
    const client = ask.length ? getClient() : undefined;
    if (client) {
      const lines = new Map(identityLines(store, workspaceId).map((line) => [line.id, line.label]));
      const tasks = store.listWorkOrders(workspaceId).filter((order) => OPEN.has(order.state) && !order.tombstone).map((order) => ({
        id: order.id, title: order.intent.slice(0, 200), line: lines.get(order.identityId) ?? "",
        steps: (store.getStepPlan(workspaceId, order.id)?.steps ?? []).filter((step) => step.status === "planned")
          .map((step) => ({ id: step.id, title: step.title.slice(0, 160), kind: STEP_ROLES[step.role as keyof typeof STEP_ROLES] ?? step.role })) }));
      const stretches = ask.map((draft) => {
        const from = zonedParts(Date.parse(draft.start), zone), to = zonedParts(Date.parse(draft.end), zone);
        return { id: draft.id, when: `${from.day} ${from.clock}–${to.clock}`, minutes: draft.minutes, app: draft.app, category: draft.category, titles: titles.get(draft.id) ?? [] };
      });
      const context = { version: "crossline.time-attribution.v1", tasks, stretches };
      const result = await runCodexSkill<TimeAttribution>(client, context, { skillName: TIME_ATTRIBUTOR, cwd,
        developerInstructions: "For each stretch of untimed screen work, name the open task (and step) its window titles plainly belong to, or none "
          + "when the titles do not tie it to one task. Never guess from the category alone. Return raw JSON only.", outputSchema: TIME_ATTRIBUTION_SCHEMA,
        prepareInput: () => context,
        validateOutput: (output) => ({ items: validateTimeAttribution(output, ask.map((draft) => draft.id), tasks.map((task) => ({ id: task.id, steps: task.steps.map((step) => step.id) }))) }),
        onAudit: () => {}, timeoutMs: 10 * 60_000 });
      if (result.ok) {
        const answers = new Map(result.output.items.map((item) => [item.id, item]));
        const asked = new Set(ask.map((draft) => draft.id));
        drafts = drafts.map((draft) => {
          if (!asked.has(draft.id)) return draft;
          const answer = answers.get(draft.id);
          if (!answer?.workOrderId) return { ...draft, asked: true };
          attributed += 1;
          return { ...draft, asked: true, workOrderId: answer.workOrderId, ...(answer.stepId ? { stepId: answer.stepId } : {}), basis: "model" as const,
            ...(answer.why ? { why: answer.why } : {}) };
        });
      } else blocked = result.blocker.code;
    }
    if (fresh.length || drafts.length !== readTimeDrafts(store, workspaceId).length || attributed || ask.length)
      store.setSetting(workspaceId, TIME_DRAFTS, JSON.stringify(drafts));
    return { drafted: fresh.length, attributed, ...(blocked ? { blocked } : {}) };
  };
}

/** The morning brief's count: yesterday's drafts (by the local day they began) the person has not decided about. */
export function unconfirmedWorkYesterday(store: CrosslineStore, workspaceId: string, today: string, zone: string): number {
  if (store.getSetting(workspaceId, ACTIVITY_DETAIL_CONSENT) !== "granted") return 0;
  const yesterday = new Date(Date.parse(`${today}T12:00:00Z`) - DAY).toISOString().slice(0, 10);
  const decided = json<Record<string, DraftDecision>>(store.getSetting(workspaceId, TIME_DRAFT_DECISIONS), {});
  return readTimeDrafts(store, workspaceId).filter((draft) => !decided[draft.id] && zonedParts(Date.parse(draft.start), zone).day === yesterday).length;
}
