import "server-only";
import { taskTitleOf, type AccessContext } from "@crossline/core";
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

/**
 * Text as `@` compares it: lower case, without spaces and punctuation, and with homework/HW/assignment read as 作业, so 「ece555」 finds
 * 「ECE 555」 and 「hw3」 finds 「作业 3」.
 */
export function mentionKey(text: string): string {
  return text.toLowerCase().replace(/[\s_\-·.,，。、:：;；/\\|()（）[\]【】「」『』"'“”‘’《》<>!?！？#*]+/g, "")
    .replace(/homework|assignment|hw/g, "作业");
}

/** Every word of the query appears in one of the texts (in any order); an empty query matches everything. */
export function mentionMatches(query: string, ...texts: string[]): boolean {
  const words = query.trim().split(/\s+/).map(mentionKey).filter(Boolean);
  const keys = texts.map(mentionKey);
  return words.every((word) => keys.some((key) => key.includes(word)));
}

const PER_KIND: Record<Mention["kind"], number> = { task: 6, milestone: 4, goal: 3, material: 6 };

/**
 * What `@` can reference: open tasks, live milestones, lines' long-term goals and the person's files, matching every word typed.
 * Each kind gets its own share of the list, tasks first: files used to come first and fill all twelve places, so once a folder was
 * authorized no task or milestone could be found (2026-10-15). `linkable` is everything but files (「关联任务或里程碑」).
 */
export function searchMentions(ctx: AccessContext, query: string, kind?: Mention["kind"] | "linkable"): Mention[] {
  const store = getStore();
  const wants = (item: Mention["kind"]) => !kind || kind === item || (kind === "linkable" && item !== "material");
  const tasks: Mention[] = !wants("task") ? [] : store.listWorkOrders(ctx.workspaceId)
    .filter((order) => !["accepted", "archived"].includes(order.state))
    .map((order) => ({ order, title: taskTitleOf(order) }))
    .filter(({ order, title }) => mentionMatches(query, title, order.intent))
    .sort((a, b) => Number(mentionMatches(query, b.title)) - Number(mentionMatches(query, a.title)))
    .map(({ order, title }) => ({ kind: "task" as const, id: order.id, title }));
  const seen = new Set<string>();
  const milestones: Mention[] = !wants("milestone") ? [] : store.listMilestones(ctx.workspaceId)
    .filter((item) => item.status !== "archived" && !seen.has(item.id) && seen.add(item.id) && mentionMatches(query, item.title))
    .map((item) => ({ kind: "milestone" as const, id: item.id, title: item.title }));
  const goals: Mention[] = !wants("goal") ? [] : identityLines(ctx).filter((line) => line.goals?.[0] && mentionMatches(query, `${line.label} ${line.goals[0]}`))
    .map((line) => ({ kind: "goal" as const, id: line.id, title: `${line.label} · ${line.goals![0]}` }));
  // The newest files first: what was just added is what the person is most likely to mean.
  const materials: Mention[] = !wants("material") ? [] : store.listSourceDocuments(ctx.workspaceId)
    .filter((doc) => mentionMatches(query, doc.fileName))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((doc) => ({ kind: "material" as const, id: doc.id, title: doc.fileName }));
  // One kind asked for: up to twenty of it. Several: each kind its share, so no kind can crowd the others out.
  const single = kind && kind !== "linkable";
  return [tasks, milestones, goals, materials].flatMap((list) => list.slice(0, single ? 20 : PER_KIND[list[0]?.kind ?? "task"]));
}
