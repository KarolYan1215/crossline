import "server-only";
import { GOAL_EDITS_SETTING, lineAttributes, type AccessContext, type AttributeCandidate, type PendingGoalEdit, type StoredLineProfile } from "@crossline/core";
import { getStore } from "./crossline";
import { identityLines, updateLine } from "./lines";
import { tOf } from "./locale";

/** One question of a line's latest interview round, as the card shows it. */
export type CardQuestion = { id: string; text: string; kind: "single" | "multi" | "free"; options: Array<{ id: string; label: string; detail: string }> };

/** What one identity card on 主线 shows beyond its name: the interview's reading of the line, its goal, and the line's own interview. */
export type LineCardDetail = {
  description: string;
  attributes: AttributeCandidate[];
  goalParts: string[];
  pendingEdit: PendingGoalEdit | null;
  /** The line's goal or its facts changed after its drafts were last proposed (§4.2): the card offers to redo the untouched drafts. */
  redraftDue: boolean;
  interview: {
    /** The latest round's reflection and questions, when the line's interview has run. */
    reply: string; questions: CardQuestion[];
    /** The person's last message has no answer yet: a turn is running, or the last one failed and can be resent. */
    waiting: boolean;
    turns: number;
  };
};

const json = <T,>(ctx: AccessContext, key: string, fallback: T): T => {
  try { return JSON.parse(getStore().getSetting(ctx.workspaceId, key) ?? "null") ?? fallback; } catch { return fallback; }
};

/**
 * Whether a line's drafts are older than what they were designed from: its goal (a `line.updated` that touched goals, an adopted goal
 * edit) or its facts changed after the last proposal for the line (or the last time the person asked for one). A line with no milestone
 * at all has no drafts to redo.
 */
export function redraftDue(input: { goalChangedAt: string; factChangedAt: string; lastDraftAt: string; hasMilestones: boolean }): boolean {
  if (!input.hasMilestones) return false;
  const changed = input.goalChangedAt > input.factChangedAt ? input.goalChangedAt : input.factChangedAt;
  return Boolean(changed) && changed > input.lastDraftAt;
}

const latest = (values: string[]) => values.reduce((max, value) => value > max ? value : max, "");

/** Everything the 主线 page's cards need, one read for all lines. */
export function lineCardDetails(ctx: AccessContext): Record<string, LineCardDetail> {
  const store = getStore();
  const profiles = json<Record<string, StoredLineProfile>>(ctx, "lines.profiles", {});
  const edits = json<Record<string, PendingGoalEdit>>(ctx, GOAL_EDITS_SETTING, {});
  const milestones = store.listMilestones(ctx.workspaceId);
  const lineOfMilestone = new Map(milestones.map((milestone) => [milestone.id, milestone.identityId]));
  const proposed = store.listEvents(ctx.workspaceId, { type: ["milestone.proposed", "line.redraft_requested"] });
  const goalEvents = store.listEvents(ctx.workspaceId, { type: ["line.updated", "line.goal_edit_adopted"] })
    .filter((event) => event.type === "line.goal_edit_adopted" || ["goals", "goal", "goalParts"].some((key) => key in ((event.payload ?? {}) as object)));
  const facts = store.listProfileFacts(ctx.workspaceId);
  const result: Record<string, LineCardDetail> = {};
  for (const line of identityLines(ctx)) {
    const profile = profiles[line.id];
    const messages = store.listOnboardingMessages(ctx.workspaceId, `line-${line.id}`);
    const lastTurn = [...messages].reverse().find((message) => message.role === "assistant")?.content as
      { reply?: string; questions?: CardQuestion[] } | undefined;
    result[line.id] = {
      description: profile?.description ?? "",
      attributes: lineAttributes(profile, line.label),
      goalParts: line.goalParts ?? [],
      pendingEdit: edits[line.id]?.parts?.length ? edits[line.id]! : null,
      redraftDue: redraftDue({
        goalChangedAt: latest(goalEvents.filter((event) => event.entityId === line.id).map((event) => event.createdAt)),
        factChangedAt: latest(facts.filter((fact) => fact.identityId === line.id).map((fact) => fact.updatedAt)),
        lastDraftAt: latest(proposed.filter((event) => event.type === "line.redraft_requested" ? event.entityId === line.id : lineOfMilestone.get(event.entityId) === line.id)
          .map((event) => event.createdAt)),
        hasMilestones: milestones.some((milestone) => milestone.identityId === line.id && milestone.status !== "archived")
      }),
      interview: {
        reply: lastTurn?.reply ?? "",
        questions: (lastTurn?.questions ?? []).map(({ id, text, kind, options }) => ({ id, text, kind, options: options ?? [] })),
        waiting: messages.at(-1)?.role === "user",
        turns: messages.filter((message) => message.role === "user").length
      }
    };
  }
  return result;
}

/** Records that the person asked for a line's drafts to be redone, so the card stops offering it until the goal or facts move again. */
export function recordRedraftRequested(ctx: AccessContext, lineIds: string[]): void {
  const store = getStore();
  const at = new Date().toISOString();
  for (const lineId of lineIds) {
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `line:redraft:${lineId}:${at}`, type: "line.redraft_requested",
      entityId: lineId, payload: { at } });
  }
}

/**
 * The person's answer to a goal change the interview recorded: `adopt` makes it the line's goal (through `updateLine`, so the parts are
 * checked like any other), `dismiss` drops it. Either way the card goes away.
 */
export function decideGoalEdit(ctx: AccessContext, lineId: string, decision: "adopt" | "dismiss"): { ok: true } | { ok: false; code: string; message?: string } {
  const store = getStore();
  const edits = json<Record<string, PendingGoalEdit>>(ctx, GOAL_EDITS_SETTING, {});
  const edit = edits[lineId];
  if (!edit?.parts?.length) return { ok: false, code: "GOAL_EDIT_NOT_FOUND", message: tOf(ctx)("这项修改已处理") };
  if (decision === "adopt") {
    const result = updateLine(ctx, lineId, { goalParts: edit.parts });
    if (!result.ok) return result;
  }
  const { [lineId]: _done, ...rest } = edits;
  store.setSetting(ctx.workspaceId, GOAL_EDITS_SETTING, JSON.stringify(rest));
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `line:goal-edit:${lineId}:${edit.at}:${decision}`,
    type: decision === "adopt" ? "line.goal_edit_adopted" : "line.goal_edit_dismissed", entityId: lineId, payload: { parts: edit.parts, sourceRef: edit.sourceRef } });
  return { ok: true };
}
