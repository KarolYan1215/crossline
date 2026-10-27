import {
  TASK_MERGE_REVIEW_SCHEMA, mergeBrief, validateTaskMergeReview, workflowMergeCandidates, workflowPairKey, workflowToKeep,
  type GrownSkillRecord, type TaskMergeReview
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import { grownHomeLine, mergeGrownSkills, readGrownSkills, type CrosslineStore } from "@crossline/db";
import { readCollectLedger, writeCollectLedger, favouritesAccess } from "./favourites-reader";
import { topicModeOn } from "./favourites-topics";
import { sayToPerson } from "./workflow-smith";
import { tOfWorkspace } from "./locale";

/**
 * Grown workflows that do the same job are made one (docs/skills-library.md 「工作流查重合并」, the owner's request of 2026-10-24: 「加一个
 * 工作流查重合并功能，不止按名字来，功能相近的就合并」). Once a day, and when the person presses 「检查重复」 in Skill 库: the rules pick the
 * pairs worth asking about (`workflowMergeCandidates`), the reviewer judges whether each pair does the same job, and each pair judged
 * the same is merged — the one kept chosen by `workflowToKeep`, the other switched off and its own ways folded into the kept one by its
 * next revision (workflow-improver.ts). The person is told and can undo it on the card (撤销合并).
 */
const REVIEWER = "crossline:crossline-validation-reviewer";
export const WORKFLOW_MERGE_CHECKED = "skills.grown.mergeCheckedOn";
/** The person asked for a check now (Skill 库 「检查重复」): run whatever day it is, as their own work. */
export const WORKFLOW_MERGE_REQUESTED = "skills.grown.mergeRequested";
/** Answers per pair, keyed by both ids at the versions judged (`workflowPairKey`): a pair is asked once per version. */
const WORKFLOW_MERGE_JUDGED = "skills.grown.mergeJudged";
const MAX_PAIRS = 8;
/** Which reading of 「the same job」 an answer was given under: answers under an older one are asked again (2: close, not only identical). */
const MERGE_CRITERIA = "c2";
const judgedKey = (a: GrownSkillRecord, b: GrownSkillRecord) => `${MERGE_CRITERIA}:${workflowPairKey(a, b)}`;

const brief = (record: GrownSkillRecord, files: (id: string) => string) => ({ summary: record.manifest.summary, description: record.description.slice(0, 400),
  // i18n-ignore-start: the reviewer's input (model-facing)
  steps: record.manifest.steps.map((step) => `${step.title}${step.by === "person" ? "（本人）" : ""}`), outputs: record.manifest.outputs ?? [],
  schedule: record.manifest.trigger === "schedule" ? JSON.stringify(record.manifest.schedule) : "按需",
  // i18n-ignore-end
  reads: (record.manifest.access ?? []).map((item) => `${item.service} ${item.site}：${item.how}`.slice(0, 200)), skill: files(record.id).slice(0, 3_000) });

/** Whether today's check is due: not run today in the person's day, or asked for. */
export function workflowMergeDue(store: CrosslineStore, workspaceId: string, today: string): "requested" | "daily" | undefined {
  if (store.getSetting(workspaceId, WORKFLOW_MERGE_REQUESTED)) return "requested";
  return store.getSetting(workspaceId, WORKFLOW_MERGE_CHECKED) === today ? undefined : "daily";
}

export async function workflowMergePass(store: CrosslineStore, workspaceId: string, client: CodexRpcBoundary | undefined, cwd: string, today: string,
  now = new Date()): Promise<Array<{ keep: string; absorbed: string }>> {
  // No model to ask: nothing is marked as checked, and the next pass tries again.
  if (!client) return [];
  const requested = Boolean(store.getSetting(workspaceId, WORKFLOW_MERGE_REQUESTED));
  store.setSetting(workspaceId, WORKFLOW_MERGE_CHECKED, today);
  store.deleteSetting(workspaceId, WORKFLOW_MERGE_REQUESTED);
  const records = readGrownSkills(store, workspaceId);
  const byId = new Map(records.map((record) => [record.id, record]));
  const pairs = workflowMergeCandidates(records, (record) => grownHomeLine(store, workspaceId, record));
  let judged: Record<string, { same: boolean; why: string }> = {};
  try { judged = JSON.parse(store.getSetting(workspaceId, WORKFLOW_MERGE_JUDGED) ?? "{}") as typeof judged; } catch { judged = {}; }
  const open = pairs.filter((pair) => judged[judgedKey(byId.get(pair.a)!, byId.get(pair.b)!)] === undefined).slice(0, MAX_PAIRS);
  const filesText = (id: string) => {
    try { return ((JSON.parse(store.getSetting(workspaceId, `skills.grown.files.${id}`) ?? "{}") as { files?: Array<{ path: string; text: string }> }).files ?? [])
      .find((file) => file.path === "SKILL.md")?.text ?? ""; } catch { return ""; }
  };
  if (open.length) {
    const input = { version: "crossline.workflow-merge-review.v1",
      pairs: open.map((pair, index) => ({ id: `p${index + 1}`, a: brief(byId.get(pair.a)!, filesText), b: brief(byId.get(pair.b)!, filesText), rule: pair.why })) };
    const result = await runCodexSkill<TaskMergeReview>(client, input, { skillName: REVIEWER, cwd,
      developerInstructions: "Decide for each pair whether the two workflows are close enough to be one, as the duplicate-workflow section of the "
        + "crossline-validation-reviewer Skill describes, and return only the requested JSON. `same: true` merges them into one workflow that "
        + "produces what both did; judge by what each works from and what it produces, not by their names.",
      outputSchema: TASK_MERGE_REVIEW_SCHEMA as unknown as Record<string, unknown>, prepareInput: () => input,
      validateOutput: (output) => validateTaskMergeReview(output, input.pairs.map((pair) => pair.id)), onAudit: () => {}, timeoutMs: 30 * 60_000 });
    if (result.ok) {
      for (const answer of result.output.pairs) {
        const pair = open[Number(answer.id.slice(1)) - 1];
        if (pair) judged[judgedKey(byId.get(pair.a)!, byId.get(pair.b)!)] = { same: answer.same, why: answer.why };
      }
      store.setSetting(workspaceId, WORKFLOW_MERGE_JUDGED, JSON.stringify(judged));
    }
  }
  const merged: Array<{ keep: string; absorbed: string }> = [];
  const gone = new Set<string>();
  const reader = (record: GrownSkillRecord) => Boolean(favouritesAccess(record)) && topicModeOn(store, workspaceId, record.id);
  for (const pair of pairs) {
    if (gone.has(pair.a) || gone.has(pair.b)) continue;
    const a = byId.get(pair.a)!, b = byId.get(pair.b)!;
    const answer = judged[judgedKey(a, b)];
    if (!answer?.same) continue;
    const [keep, absorb] = workflowToKeep(a, b, reader);
    const why = answer.why || pair.why;
    if (!mergeGrownSkills(store, workspaceId, keep.id, absorb.id, why, mergeBrief(keep, absorb, why), now)) continue;
    // Two readers of the same favourites: what the absorbed one listed or read goes into the kept one's ledger.
    if (favouritesAccess(keep) && favouritesAccess(absorb)) {
      const from = readCollectLedger(store, workspaceId, absorb.id), into = readCollectLedger(store, workspaceId, keep.id);
      writeCollectLedger(store, workspaceId, keep.id, { ...into, listed: { ...(from.listed ?? {}), ...(into.listed ?? {}) }, read: { ...from.read, ...into.read } });
    }
    gone.add(absorb.id);
    merged.push({ keep: keep.id, absorbed: absorb.id });
    const t = tOfWorkspace(store, workspaceId);
    sayToPerson(store, workspaceId, t("工作流「{{absorbed}}」和「{{kept}}」做的是同一件事（{{why}}），已合并：前者已关闭，它独有的做法会并进后者的下一版。不合适可在设置里撤销合并。",
      { absorbed: absorb.manifest.summary, kept: keep.manifest.summary, why }),
      "workflow_merged", `merged:${absorb.id}:${keep.id}`, [{ label: t("查看或撤销"), href: "/settings#skills" }], now);
  }
  if (requested && !merged.length) sayToPerson(store, workspaceId, pairs.length
    ? tOfWorkspace(store, workspaceId)("检查了 {{count}} 对可能重复的工作流，功能都不相同，没有合并。", { count: pairs.length })
    : tOfWorkspace(store, workspaceId)("没有找到可能重复的工作流。"),
    "workflow_merged", `merge-none:${today}:${now.getTime()}`, [], now);
  return merged;
}
