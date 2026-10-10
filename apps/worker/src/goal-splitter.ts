import { createHash } from "node:crypto";
import {
  GOAL_SPLIT_SCHEMA, duplicateAttributes, keepGoalSplit, lineAttributes, recomposes, validateGoalSplit,
  type AttributeCandidate, type GoalSplit, type GoalSplitContext, type StoredLineProfile
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { LINE_SETTING, readLineSpecs } from "@crossline/identity-packs";
import { identityLines } from "./lines";
import { ownerOf } from "./owner";

export const GOAL_SPLITTER = "crossline:crossline-goal-splitter";

const goalHash = (goal: string) => createHash("sha256").update(goal.trim()).digest("hex").slice(0, 16);

/**
 * Lines whose adopted goal was written as a whole sentence and has not been split into attributes yet (§4.1). Each goal is split once:
 * a `line.goal_split` event records it, so a goal kept whole (no split recomposed it) is not sent again on every tick, and a goal the
 * person rewrites later is a new goal and is split again.
 */
export function linesAwaitingSplit(store: CrosslineStore, workspaceId: string): GoalSplitContext["lines"] {
  const done = new Set(store.listEvents(workspaceId, { type: "line.goal_split" }).map((event) => `${event.entityId}:${(event.payload as { goalHash?: string }).goalHash ?? ""}`));
  return identityLines(store, workspaceId)
    .filter((line) => (line.goals ?? []).length > 0 && !(line.goalParts ?? []).length && !done.has(`${line.id}:${goalHash(line.goals![0]!)}`))
    .map((line) => ({ id: line.id, label: line.label, goals: line.goals! }));
}

/**
 * Splits each such goal into its attributes with a small model and keeps them chosen, in order, so the composed goal is the sentence the
 * person adopted — checked in code (`recomposes`); a goal no split recomposes is kept whole as one attribute. The goal's wording is never
 * changed here: `goals[0]` stays as written, `goalParts` is added beside it. The parts of the line's other goals join its candidates.
 */
export function createGoalSplitter(store: CrosslineStore, workspaceId: string, cwd: string, getClient: () => CodexRpcBoundary | undefined) {
  return async function split(): Promise<{ split: number } | { blocked: string }> {
    const client = getClient();
    if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
    const lines = linesAwaitingSplit(store, workspaceId).slice(0, 12);
    if (!lines.length) return { split: 0 };
    const context: GoalSplitContext = { version: "crossline.goal-split.v1", lines };
    const result = await runCodexSkill<GoalSplit>(client, context, {
      skillName: GOAL_SPLITTER, cwd, outputSchema: GOAL_SPLIT_SCHEMA,
      developerInstructions: "Split each long-term goal into its attributes as the Skill describes: cut the sentence's own words, never add, drop or reword. Return raw JSON only.",
      prepareInput: () => context, validateOutput: (output) => validateGoalSplit(output, context),
      // Repairs spent: every goal that splits cleanly keeps its split, every other one stays whole.
      softAccept: (_rejection, output) => keepGoalSplit(output, context),
      onAudit: () => {}, timeoutMs: 20 * 60_000
    });
    if (!result.ok) return { blocked: result.blocker.code };
    const ownerId = ownerOf(store, workspaceId);
    // Read again: the person may have changed a goal while the model ran, and their change wins.
    const specs = readLineSpecs((key) => store.getSetting(workspaceId, key)) ?? [];
    let profiles: Record<string, StoredLineProfile> = {};
    try { profiles = JSON.parse(store.getSetting(workspaceId, "lines.profiles") ?? "{}") ?? {}; } catch { /* rebuilt below */ }
    let count = 0;
    for (const answered of result.output.lines) {
      const line = lines.find((item) => item.id === answered.lineId);
      const spec = specs.find((item) => item.id === answered.lineId);
      const first = answered.goals.find((goal) => goal.goal === line?.goals[0]);
      const current = spec ? (spec.goals?.length ? spec.goals : spec.goal ? [spec.goal] : []) : [];
      if (!line || !spec || !first || spec.goalParts?.length || current[0] !== line.goals[0]) continue;
      spec.goalParts = first.parts.map((part) => part.text);
      // Every goal's parts become candidates too (the first one's chosen, the others' offered), labelled as coming from the adopted goal.
      const existing = lineAttributes(profiles[line.id], line.label);
      const added: AttributeCandidate[] = [];
      for (const part of answered.goals.flatMap((goal) => goal.parts)) {
        if (duplicateAttributes([...existing, ...added].map((item) => item.text).concat(part.text)).some((pair) => pair.includes(part.text))) continue;
        added.push({ text: part.text, kind: part.kind, sourceRef: "goal" });
      }
      profiles[line.id] = { description: profiles[line.id]?.description ?? "", attributes: [...existing, ...added] };
      store.appendEvent({ ownerId, workspaceId, idempotencyKey: `line:goal-split:${line.id}:${goalHash(line.goals[0]!)}`, type: "line.goal_split", entityId: line.id,
        payload: { goal: line.goals[0], goalHash: goalHash(line.goals[0]!), parts: spec.goalParts, kinds: first.parts.map((part) => part.kind),
          recomposed: recomposes(spec.goalParts, line.label, line.goals[0]!) } });
      count += 1;
    }
    if (count) {
      store.setSetting(workspaceId, LINE_SETTING, JSON.stringify(specs));
      store.setSetting(workspaceId, "lines.profiles", JSON.stringify(profiles));
    }
    return { split: count };
  };
}
