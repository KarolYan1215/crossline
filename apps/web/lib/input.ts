import "server-only";
import type { AccessContext } from "@crossline/core";
import { getStore, saveMilestoneEdit } from "./crossline";
import { identityLines } from "./lines";

export type Mention = { kind: "material" | "task" | "milestone" | "goal"; id: string; title: string };

/**
 * A milestone the person stated: a draft on its line, approved on the 主线 page like any other. Its deadline (when said) and target go
 * into its anchor, which is where the timeline reads a draft's date from.
 */
export function createMilestoneDraft(ctx: AccessContext, input: { lineId: string; title: string; date: string; target: string }): { ok: true; id: string } | { ok: false; code: string } {
  const saved = saveMilestoneEdit(ctx, { identityId: input.lineId, projectId: "", title: input.title, status: "draft", successCriteria: [] });
  if (!saved.ok) return saved;
  if (input.date || input.target) getStore().saveMilestoneAnchor({ workspaceId: ctx.workspaceId, milestoneId: saved.id, stage: 1, deadline: input.date, baseline: "",
    target: input.target.slice(0, 500), stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: new Date().toISOString() });
  return { ok: true, id: saved.id };
}

/** What `@` can reference: the person's files, open tasks and live milestones, matching the typed text. */
export function searchMentions(ctx: AccessContext, query: string, kind?: Mention["kind"]): Mention[] {
  const store = getStore();
  const q = query.trim().toLowerCase();
  const match = (text: string) => !q || text.toLowerCase().includes(q);
  const results: Mention[] = [];
  if (!kind || kind === "material") results.push(...store.listSourceDocuments(ctx.workspaceId).filter((doc) => match(doc.fileName))
    .map((doc) => ({ kind: "material" as const, id: doc.id, title: doc.fileName })));
  if (!kind || kind === "task") results.push(...store.listWorkOrders(ctx.workspaceId).filter((order) => !["accepted", "archived"].includes(order.state) && match(order.intent))
    .map((order) => ({ kind: "task" as const, id: order.id, title: order.intent })));
  if (!kind || kind === "milestone") results.push(...store.listMilestones(ctx.workspaceId).filter((item) => item.status !== "archived" && match(item.title))
    .map((item) => ({ kind: "milestone" as const, id: item.id, title: item.title })));
  // A line's long-term goal, by the line's id; few enough that each matching one keeps its place at the end of the list.
  const goals = !kind || kind === "goal" ? identityLines(ctx).filter((line) => line.goals?.[0] && match(`${line.label} ${line.goals[0]}`))
    .map((line) => ({ kind: "goal" as const, id: line.id, title: `${line.label} · ${line.goals![0]}` })) : [];
  return [...results.slice(0, 12 - goals.length), ...goals];
}
