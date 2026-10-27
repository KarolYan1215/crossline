import { textSimilarity } from "./task-merge";
import { workflowAccess, type GrownSkillRecord } from "./workflows";

/**
 * Two grown workflows that do the same thing (docs/skills-library.md 「工作流查重合并」, the owner's request of 2026-10-24: 「不止按名字来，
 * 功能相近的就合并」). The rules here only pick the pairs worth asking about — same line, and the same site behind a login, or what they
 * say they do close in words — and which of a pair to keep; whether two do the same job is the reviewer's call
 * (`crossline-validation-reviewer`, `crossline.workflow-merge-review.v1`), since two workflows can share every word and do different
 * work, or share none and do the same.
 */

/** What a workflow says it does: its summary, description, steps and outputs, as one text to compare. */
export const workflowText = (record: GrownSkillRecord) =>
  [record.manifest.summary, record.description, ...record.manifest.steps.map((step) => step.title), ...(record.manifest.outputs ?? [])].join(" ");

const loginHosts = (record: GrownSkillRecord) => new Set(workflowAccess(record).access.filter((item) => item.login)
  .map((item) => { try { return new URL(item.site).hostname.replace(/^www\./, "").toLowerCase(); } catch { return ""; } }).filter(Boolean));

/** Pairs below this word similarity, sharing no logged-in site, are not asked about. */
export const MERGE_ASK_SIMILARITY = 0.3;

export type WorkflowPair = { a: string; b: string; why: string; similarity: number };

/**
 * The pairs worth asking about, among workflows still kept (on, off or waiting for consent; never one already merged away), each pair on
 * the same line (`homeOf`). Returns them closest first.
 */
export function workflowMergeCandidates(records: readonly GrownSkillRecord[], homeOf: (record: GrownSkillRecord) => string | undefined): WorkflowPair[] {
  const kept = records.filter((record) => !record.mergedInto);
  const pairs: WorkflowPair[] = [];
  for (let i = 0; i < kept.length; i += 1) for (let j = i + 1; j < kept.length; j += 1) {
    const a = kept[i]!, b = kept[j]!;
    const line = homeOf(a);
    if (!line || line !== homeOf(b)) continue;
    const shared = [...loginHosts(a)].filter((host) => loginHosts(b).has(host));
    const similarity = textSimilarity(workflowText(a), workflowText(b));
    if (!shared.length && similarity < MERGE_ASK_SIMILARITY) continue;
    pairs.push({ a: a.id, b: b.id, similarity,
      // i18n-ignore: told to the reviewer and the reviser, and compared below
      why: shared.length ? `都在本人登录的 ${shared.join("、")} 上读取` : `说明文字相近（相似度 ${similarity}）` });
  }
  return pairs.sort((x, y) => (y.why.startsWith("都在") ? 1 : 0) - (x.why.startsWith("都在") ? 1 : 0) || y.similarity - x.similarity); // i18n-ignore
}

/** The key a pair's answer is remembered under: both ids with the version each was judged at, so a revised one is asked again. */
export const workflowPairKey = (a: GrownSkillRecord, b: GrownSkillRecord) =>
  [`${a.id}@${a.version ?? 1}`, `${b.id}@${b.version ?? 1}`].sort().join("|");

/**
 * Which of two workflows doing the same job is kept: the one that reads the site for the account (`reader`, the favourites in topic
 * mode), then one that is on, one the person kept, one they asked for in words, the one run most recently, the older one.
 */
export function workflowToKeep(a: GrownSkillRecord, b: GrownSkillRecord, reader: (record: GrownSkillRecord) => boolean): [keep: GrownSkillRecord, absorb: GrownSkillRecord] {
  const rank = (record: GrownSkillRecord): number[] => [reader(record) ? 1 : 0, record.status === "active" ? 1 : 0, record.pinned ? 1 : 0,
    record.origin.kind === "asked" ? 1 : 0, Date.parse(record.lastRunAt ?? "") || 0, -Date.parse(record.createdAt)];
  const x = rank(a), y = rank(b);
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i]! > y[i]! ? [a, b] : [b, a];
  return [a, b];
}

/** What the kept workflow is asked to take over from the one merged into it (the reason for its next revision). */
// An instruction to the assistant that revises the kept workflow.
/* i18n-ignore-start */
export function mergeBrief(keep: GrownSkillRecord, absorb: GrownSkillRecord, why: string): string {
  const own = absorb.manifest.steps.map((step) => step.title).join("；");
  const when = absorb.manifest.trigger === "schedule" && absorb.manifest.schedule ? `；它有固定时间（${JSON.stringify(absorb.manifest.schedule)}），若本工作流没有，改成同样的时间` : "";
  return `合并工作流「${absorb.manifest.summary}」（${why}）：它已关闭，把它有而「${keep.manifest.summary}」没有的做法和产出并进来（它的步骤：${own}${when}），`
    + "它的文件在只读输入 absorbed/ 下；两者重复的部分不重复写。";
}
/* i18n-ignore-end */
