import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  WORKFLOW_FEEDBACK_EVENT, classifyAgentFailure, finalVerdict, grownSkillFilesKey, grownSkillName, scanForDeclaredAccess, scanSkillFiles, skillFrontmatter, validateWorkflowManifest,
  workflowLineDiff, tFor, type GrownSkillRecord, type Locale, type Translate, type WorkflowManifest
} from "@crossline/core";
import type { CodexRpcBoundary } from "@crossline/codex";
import { listAgentTasks, readGrownSkills, reviseGrownSkill, writeGrownSkills, type CrosslineStore } from "@crossline/db";
import type { DispatchResult } from "./agent-service";
import type { AgentOutcome, AgentTaskInput } from "./agent-task";
import { identityLines } from "./lines";
import { ownerOf } from "./owner";
import { localeOf } from "./locale";
import { readRunFile, readSkillDir, reviewWorkflow, sayToPerson, SKILL_CREATOR } from "./workflow-smith";

/**
 * Crossline revises its own workflows (docs/skills-library.md 「工作流自我改进」, the owner's request of 2026-10-24: 「crossline 自己能够
 * 迭代优化工作流，用户不能使用 coding agent 进行修复」). A workflow's runs leave signals — what the person said about it on its card
 * (`skill.grown.feedback`), their notes when they reviewed or sent back one of its results, a run they asked to redo with words, and
 * runs that failed for reasons of their own — and when there is a reason to change it the assistant revises the workflow's files with
 * the runtime's `skill-creator`. The revision goes through the same checks a new workflow does (manifest, scan, review), replaces the
 * version in force with the old one kept, and is said to the person with what changed; 「回到上一版」 on the card takes it back.
 *
 * What it can change is what a workflow is: its SKILL.md, its scripts and its manifest. Crossline's own code (the favourites reader, the
 * pace, the checks) is not a workflow and is not changed this way; a revision that reaches further than what the person agreed to (a new
 * site, login, risk or step leaving the machine) waits for their consent again (`revisionWidens`).
 *
 * A revision whose inputs held someone else's words — a result folder of a run that read mail, web pages, a site or an untrusted folder —
 * is not put in force by itself (the owner's decision of 2026-11-25, docs/plans/harness-1125.md 「Skill 供应链」): those words could have
 * written the new version. It passes the same checks, then waits as `pendingRevision` with a diff in its run's folder, and that run's
 * result goes to 待确认; the person's 采纳 puts it in force, 退回 drops it. A revision from the person's feedback and failures alone, with
 * no such folder, is put in force as before.
 */
type RunFree = (input: AgentTaskInput & { taskId: string }, after?: (outcome: AgentOutcome | { state: "failed"; message: string }) => void) => DispatchResult;
export type ImprovementSignal = { at: string; kind: "feedback" | "review" | "retry" | "failure" | "merge"; text: string; taskId?: string; absorbed?: string };
/** Signals that come from the person (their own work, run while the quota lasts); a merge and failures are the system's idea. */
const fromPerson = (signal: ImprovementSignal) => signal.kind === "feedback" || signal.kind === "review" || signal.kind === "retry";

/** A revision is tried again after this long when the signals it answered are still there (it failed, or found nothing to change). */
export const IMPROVE_COOLDOWN_MS = 6 * 3_600_000;
/** Runs of its own that failed since the last revision before failures alone are a reason to revise: one (the owner, 2026-11-04: a
 *  workflow that goes wrong is repaired by Crossline, not left to the person); the cooldown and the tries per set still bound it. */
export const FAILURES_TO_IMPROVE = 1;
/** Tries per set of signals: past this, only something new the person says starts another. */
const ATTEMPTS_PER_SIGNALS = 3;

/** The assistant runs a workflow starts (its scheduled runs, organising favourites): their task ids begin with this. */
export const workflowRunPrefix = (id: string) => `flow-${id.replace(/^flow-/, "")}-`;
const improveTaskPrefix = (id: string) => `improve-${id.replace(/^flow-/, "")}-`;

/** What the person and the workflow's own runs said since it was last revised (or installed). */
export function improvementSignals(store: CrosslineStore, workspaceId: string, record: GrownSkillRecord): ImprovementSignal[] {
  const since = record.improvedAt ?? record.createdAt;
  const prefix = workflowRunPrefix(record.id);
  const after = (at: string) => at > since;
  const signals: ImprovementSignal[] = [];
  // A merge is a reason only while the absorbed workflow is still merged into this one: once undone (or the absorbed one removed), it is not taken over.
  const stillAbsorbed = new Set(readGrownSkills(store, workspaceId).filter((item) => item.mergedInto?.id === record.id).map((item) => item.id));
  for (const event of store.listEvents(workspaceId, { type: WORKFLOW_FEEDBACK_EVENT, entityId: record.id })) {
    if (!after(event.createdAt)) continue;
    const payload = event.payload as { text?: string; absorbed?: string };
    if (payload.absorbed && !stillAbsorbed.has(payload.absorbed)) continue;
    signals.push({ at: event.createdAt, kind: payload.absorbed ? "merge" : "feedback", text: String(payload.text ?? ""), ...(payload.absorbed ? { absorbed: payload.absorbed } : {}) });
  }
  for (const event of store.listEvents(workspaceId, { type: "agent.task.reviewed" })) {
    const payload = event.payload as { taskId?: string; note?: string; decision?: string; by?: string };
    if (!String(payload.taskId ?? "").startsWith(prefix) || !payload.note?.trim() || payload.by === "system" || !after(event.createdAt)) continue;
    // i18n-ignore: a line of the reviser's brief (model-facing)
    signals.push({ at: event.createdAt, kind: "review", text: `${payload.decision === "accepted" ? "采纳时的意见" : "退回的理由"}：${payload.note.trim()}`, taskId: payload.taskId! });
  }
  for (const event of store.listEvents(workspaceId, { type: "agent.retry_requested" })) {
    const payload = event.payload as { taskId?: string; note?: string; by?: string };
    if (!String(payload.taskId ?? "").startsWith(prefix) || !payload.note?.trim() || payload.by !== "person" || !after(event.createdAt)) continue;
    signals.push({ at: event.createdAt, kind: "retry", text: `要求重做：${payload.note.trim()}`, taskId: payload.taskId! }); // i18n-ignore: model-facing
  }
  // A failure of its own (not a restart, a stop, the quota or the site's check, which no change to the workflow answers).
  for (const run of listAgentTasks(store, workspaceId)) {
    if (!run.taskId.startsWith(prefix) || run.status !== "blocked" || !after(run.requestedAt)) continue;
    const failure = classifyAgentFailure(run);
    if (failure.kind !== "hard" && failure.kind !== "needs_input") continue;
    signals.push({ at: run.requestedAt, kind: "failure", text: `运行失败：${failure.stuckAt}`, taskId: run.taskId }); // i18n-ignore: model-facing
  }
  return signals.sort((a, b) => a.at.localeCompare(b.at));
}

/** Whether to revise it now: something the person said, or failures enough, newer than the cooldown allows, within the tries a set gets. */
export function improvementDue(store: CrosslineStore, workspaceId: string, record: GrownSkillRecord, now = new Date()): ImprovementSignal[] | undefined {
  // One revision waiting for the person is enough: the signals it answered stay until they decide.
  if (record.status !== "active" || record.pendingRevision) return undefined;
  const signals = improvementSignals(store, workspaceId, record);
  const person = signals.filter((signal) => signal.kind !== "failure");
  if (!person.length && signals.length < FAILURES_TO_IMPROVE) return undefined;
  // A merge is answered like what the person said: at once, then on the same cooldown.
  const since = record.improvedAt ?? record.createdAt;
  const attempts = store.listEvents(workspaceId, { type: "skill.grown.improve_started", entityId: record.id }).filter((event) => event.createdAt > since);
  const last = attempts.at(-1);
  // Something the person said after the last try starts one at once; otherwise the cooldown, and a bounded number of tries.
  if (last && !person.some((signal) => signal.at > last.createdAt)) {
    if (now.getTime() - Date.parse(last.createdAt) < IMPROVE_COOLDOWN_MS || attempts.length >= ATTEMPTS_PER_SIGNALS) return undefined;
  }
  return signals;
}

/** What the assistant is asked when it revises a workflow: its files in force (read-only input), the signals, and the rules a revision keeps. */
export function improveTask(record: GrownSkillRecord, current: string, signals: ImprovementSignal[], results: string[], taskId: string, locale?: Locale): AgentTaskInput & { taskId: string } {
  const t = tFor(locale);
  const lines = signals.slice(-12).map((signal) => `- ${signal.at.slice(0, 10)} ${signal.text.slice(0, 600)}`);
  return {
    taskId, category: record.category, prep: true, extraSkills: [SKILL_CREATOR], lineId: record.lines[0] ?? "", growing: true,
    title: t("改进工作流：{{summary}}", { summary: record.manifest.summary }).slice(0, 80), humanPart: t("改好后会告诉本人，不合适可回到上一版。"),
    inputs: [current, ...results],
    /* i18n-ignore-start: the reviser's brief (model-facing) */
    what: [
      `按 $skill-creator 改进工作流「${record.manifest.summary}」（$${grownSkillName(record.id)}）。它现在的文件在只读输入 ${path.basename(current)}/skill/ 里（SKILL.md、workflow.json 和脚本）${results.length ? "，最近几次运行的结果也作为只读输入给你" : ""}。`,
      "要回应的是这些（本人说的优先，其次是运行失败）：", ...lines,
      "在任务目录下写出改好后的完整 skill/ 文件夹（照原样带上不需要改的文件），并写 skill/CHANGES.md：一到五行，说改了什么、对应上面哪一条。",
      "只改这些意见和失败要求改的地方，不加没人要求的功能。workflow.json 的 name、lines、category 不变；不新增要读的网站、登录、风险或离开本机的步骤，除非本人明确要求（那样会请本人重新同意）。发送、上传、发布、付款一类的步骤仍由本人完成。安全规定（不改动账号、遇到验证就停、不伪装浏览器）原样保留。",
      "改了脚本的话，能运行就用离线样例实际跑通；不能运行就只改到读得出确实正确的程度。",
      "上面的意见都不需要改文件就能做到（例如是一次性的要求），或者没法从工作流本身改好（是 Crossline 程序的问题）：不写 skill/，只写 NO_CHANGE.md，一两句说明原因。",
      "这次只改工作流，不执行它本身，不访问需要登录的网站。"
    ].join("\n")
    /* i18n-ignore-end */
  };
}

/**
 * Reads back what the revising run wrote and puts it in force when it passes the checks a new workflow passes; tells the person either
 * way. A run that judged no change was needed says why and counts as answering the signals.
 */
export async function installRevision(store: CrosslineStore, workspaceId: string, record: GrownSkillRecord, outcome: AgentOutcome | { state: "failed"; message: string },
  deps: { client: CodexRpcBoundary | undefined; cwd: string; now?: () => Date;
    /** What the revision read that someone else wrote (`revisionTaint`): non-empty, it waits for the person instead of going in force. */
    untrusted?: string[] }): Promise<{ state: "revised"; version: number } | { state: "pending"; untrusted: string[] } | { state: "unchanged" | "rejected" | "skipped"; reason: string }> {
  const now = deps.now?.() ?? new Date();
  const ownerId = ownerOf(store, workspaceId);
  const locale = localeOf(store, workspaceId);
  const t = tFor(locale);
  const summary = record.manifest.summary;
  const reject = (reason: string) => {
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: `skill.grown.revision_rejected:${record.id}:${now.getTime()}`, type: "skill.grown.revision_rejected",
      entityId: record.id, payload: { id: record.id, reason: reason.slice(0, 300) } });
    return { state: "rejected" as const, reason };
  };
  // The person turned it off, reverted it or accepted new risks while the run worked: the revision was made for a state that is gone.
  const moved = (): string | undefined => {
    const current = readGrownSkills(store, workspaceId).find((item) => item.id === record.id);
    if (!current) return "removed";
    if (current.status !== record.status) return "status_changed";
    return (current.version ?? 1) !== (record.version ?? 1) ? "version_changed" : undefined;
  };
  const skip = (reason: string) => {
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: `skill.grown.revision_skipped:${record.id}:${now.getTime()}`, type: "skill.grown.revision_skipped",
      entityId: record.id, payload: { id: record.id, reason, version: record.version ?? 1 } });
    return { state: "skipped" as const, reason };
  };
  const early = moved();
  if (early) return skip(early);
  if (outcome.state !== "done") return reject(outcome.state === "failed" || outcome.state === "blocked" ? outcome.message || t("运行失败") : t("助手未获准做这类工作"));
  const read = readSkillDir(path.join(outcome.directory, "skill"), t);
  if (read.problem) {
    const why = readRunFile(outcome.directory, "NO_CHANGE.md")?.trim() ?? "";
    if (why) {
      // Answered without a change: the signals are settled until something new comes (`improvedAt`).
      store.appendEvent({ ownerId, workspaceId, idempotencyKey: `skill.grown.improve_skipped:${record.id}:${now.getTime()}`, type: "skill.grown.improve_skipped",
        entityId: record.id, payload: { id: record.id, why: why.slice(0, 400) } });
      writeGrownSkills(store, workspaceId, readGrownSkills(store, workspaceId).map((item) => item.id === record.id ? { ...item, improvedAt: now.toISOString() } : item));
      sayToPerson(store, workspaceId, t("看过对工作流「{{summary}}」的意见，这次没有改它：{{why}}", { summary, why: why.slice(0, 200) }), "workflow_improved", `improve-skip:${record.id}:${now.getTime()}`,
        [{ label: t("去看工作流"), href: `/automation/${encodeURIComponent(record.id)}` }], now);
      return { state: "unchanged", reason: why };
    }
    return reject(read.problem);
  }
  const skillText = read.files.find((file) => file.path === "SKILL.md")?.text ?? "";
  const front = skillFrontmatter(skillText);
  if (!front) return reject(t("SKILL.md 没有 name 和 description"));
  let manifest;
  try {
    const raw = JSON.parse(read.files.find((file) => file.path === "workflow.json")?.text ?? "null") as unknown;
    manifest = { ...validateWorkflowManifest(raw, identityLines(store, workspaceId).map((line) => line.id)), lines: record.manifest.lines,
      name: record.manifest.name, category: record.manifest.category };
  } catch (error) { return reject(t("workflow.json 不合格：{{detail}}", { detail: (error as Error & { detail?: string }).detail ?? (error as Error).message })); }
  const scan = scanForDeclaredAccess(scanSkillFiles(read.files), manifest.access.length > 0);
  if (!deps.client) return reject(t("审查未完成：模型服务不可用"));
  const changes = (read.files.find((file) => file.path === "CHANGES.md")?.text ?? "").trim() || t("按反馈调整");
  // i18n-ignore: the reviewer's input (model-facing)
  const reviewed = await reviewWorkflow(deps.client, deps.cwd, { name: front.name, description: front.description, origin: "按本人的意见和运行情况修订", why: changes }, manifest, read.files, scan);
  if (!reviewed.ok) return reject(t("审查未完成：{{message}}", { message: reviewed.blocker.message }));
  const final = finalVerdict(scan, reviewed.output);
  if (final === "reject") return reject(scan.injection ? t("SKILL.md 含有要求模型越权或外传的语句") : reviewed.output.reasons.join(locale === "en" ? "; " : "；").slice(0, 300));
  const files = read.files.filter((file) => file.path !== "CHANGES.md");
  // The review took a while: checked again right before it is put in force.
  const late = moved();
  if (late) return skip(late);
  if (deps.untrusted?.length) {
    holdRevision(store, workspaceId, record, { taskId: outcome.taskId, directory: outcome.directory, files, changes, untrusted: deps.untrusted,
      review: { ...reviewed.output, final } }, now, t);
    return { state: "pending", untrusted: deps.untrusted };
  }
  const revised = reviseGrownSkill(store, workspaceId, record.id, { manifest, files, scan, review: { ...reviewed.output, final }, changes, taskId: outcome.taskId }, now);
  if (!revised) return reject(t("工作流已被删除"));
  const values = { summary, version: revised.version, changes: changes.replace(/\s*\n+\s*/g, locale === "en" ? "; " : "；").slice(0, 300) };
  sayToPerson(store, workspaceId, revised.needsConsent
    ? t("工作流「{{summary}}」按意见改了（第 {{version}} 版）：{{changes}}。改后要读的内容或风险有变，请本人重新看过风险再启用。", values)
    : t("工作流「{{summary}}」按意见改了（第 {{version}} 版）：{{changes}}。下次运行就按新版做；不合适可在设置里回到上一版。", values),
    "workflow_improved", `improved:${record.id}:${revised.version}`, [{ label: revised.needsConsent ? t("查看风险并启用") : t("查看或回到上一版"), href: `/automation/${encodeURIComponent(record.id)}` }], now);
  return { state: "revised", version: revised.version };
}

// ── Revisions that read someone else's words ────────────────────────────────────────────────────────────────────────────

/** A result folder's own mark that it holds untrusted content (the assistant's taint tracking may leave one; docs/claude/personal-agent.md). */
const UNTRUSTED_MARKS = ["untrusted.json", ".untrusted"];
const sameDirectory = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/**
 * What in the folders a revision is handed was written by someone else, judged from each folder's own run (docs/plans/harness-1125.md
 * 「Skill 供应链」). A folder is untrusted when its run's `agent.task.requested` says so (`untrusted` labels, the `untrusted-input`
 * profile), when that run was itself handed a site's collection (`collect-*`) or another workflow run's output (`flow-*`), when it searched
 * the web, when the folder carries a mark (`untrusted.json`, `.untrusted`), or when no run of this workspace made it (unknown is untrusted).
 * Returns the labels found, none for a revision from the person's feedback and failures alone.
 */
export function revisionTaint(store: CrosslineStore, workspaceId: string, directories: string[]): string[] {
  const found = new Set<string>();
  const runs = listAgentTasks(store, workspaceId);
  for (const directory of directories) {
    if (UNTRUSTED_MARKS.some((mark) => readRunFile(directory, mark) !== undefined)) found.add("marked");
    const run = runs.find((item) => item.directory && sameDirectory(item.directory, directory));
    const requested = run ? store.listEvents(workspaceId, { type: "agent.task.requested", entityId: run.taskId }).at(-1)?.payload as Record<string, unknown> | undefined : undefined;
    if (!run || !requested) { found.add("unknown"); continue; }
    if (Array.isArray(requested.untrusted)) for (const label of requested.untrusted) found.add(String(label));
    else if (requested.untrusted === true) found.add("untrusted");
    if (requested.profile === "untrusted-input") found.add("untrusted-input");
    for (const input of Array.isArray(requested.inputs) ? requested.inputs.map(String) : []) {
      const top = path.basename(input);
      if (/^collect-/i.test(top) || input.split(/[\\/]/).some((part) => /^collect-/i.test(part))) found.add("site");
      else if (input.split(/[\\/]/).some((part) => /^flow-/i.test(part))) found.add("workflow-output");
    }
    for (const label of completedTaint(store, workspaceId, run.taskId)) found.add(label);
  }
  return [...found];
}

/**
 * What a finished run read of someone else's words, from its `agent.task.completed`: the tools mode's own taint record (`tainted`: mail,
 * page, document…) and a hosted search (`searches`). Review of 2026-11-25: the tools mode never counts `searches`, so `tainted` is read too.
 */
export function completedTaint(store: CrosslineStore, workspaceId: string, taskId: string): string[] {
  const completed = store.listEvents(workspaceId, { type: "agent.task.completed", entityId: taskId }).at(-1)?.payload as { searches?: number; tainted?: unknown } | undefined;
  const found = Array.isArray(completed?.tainted) ? completed.tainted.map(String) : [];
  if (Number(completed?.searches ?? 0) > 0) found.push("web");
  return [...new Set(found)];
}

const revisionDigest = (files: Array<{ path: string; text: string }>) => {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) hash.update(`${file.path}\0${file.text}\0`);
  return hash.digest("hex");
};

/** The change, file by file, as the person reads it on 待确认: unchanged lines left out, each file's added and removed lines. */
function revisionDiff(before: Array<{ path: string; text: string }>, after: Array<{ path: string; text: string }>, header: string): string {
  const paths = [...new Set([...before, ...after].map((file) => file.path))].sort();
  const sections = paths.flatMap((file) => {
    const old = before.find((item) => item.path === file)?.text ?? "";
    const now = after.find((item) => item.path === file)?.text ?? "";
    if (old === now) return [];
    const lines = workflowLineDiff(old, now).filter((line) => line.op !== "same").map((line) => `${line.op === "add" ? "+" : "-"} ${line.text}`);
    return [`## ${file}`, "", "```diff", ...lines.slice(0, 400), ...(lines.length > 400 ? [`… ${lines.length - 400}`] : []), "```", ""];
  });
  return [header, "", ...sections].join("\n");
}

/** Keeps a checked revision that read untrusted content for the person: the diff in its folder, its result back on 待确认, the person told. */
function holdRevision(store: CrosslineStore, workspaceId: string, record: GrownSkillRecord,
  next: { taskId: string; directory: string; files: Array<{ path: string; text: string }>; changes: string; untrusted: string[]; review: NonNullable<GrownSkillRecord["pendingRevision"]>["review"] },
  now: Date, t: Translate): void {
  const at = now.toISOString();
  const sources = next.untrusted.join(", ");
  // i18n-ignore: the file's heading is read with the files it introduces, in the workspace's language below
  writeFileSync(path.join(next.directory, "REVISION-DIFF.md"), revisionDiff(storedFiles(store, workspaceId, record.id), next.files,
    t("# 工作流「{{summary}}」的修订（待本人采纳）\n\n这次修订读过别人写的内容（{{sources}}），所以不会自己生效：在待确认里采纳这次运行的结果，新版才生效；退回则不改。\n\n改了什么：{{changes}}",
      { summary: record.manifest.summary, sources, changes: next.changes.replace(/\s*\n+\s*/g, "；").slice(0, 400) })), "utf8");
  writeGrownSkills(store, workspaceId, readGrownSkills(store, workspaceId).map((item) => item.id !== record.id ? item : { ...item,
    pendingRevision: { taskId: next.taskId, directory: next.directory, digest: revisionDigest(next.files), fromVersion: record.version ?? 1, untrusted: next.untrusted,
      changes: next.changes.slice(0, 600), review: next.review, at } }));
  // The run's result is the decision: back on 待确认 even though it was accepted by itself.
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `agent.task.reopened:${next.taskId}:untrusted`, type: "agent.task.reopened",
    entityId: next.taskId, payload: { taskId: next.taskId, why: "untrusted_revision", workflowId: record.id, untrusted: next.untrusted } });
  sayToPerson(store, workspaceId, t("工作流「{{summary}}」按意见改好了，但这次修改读过别人写的内容（{{sources}}），要本人在待确认里看过改动再生效；不采纳就保持原样。",
    { summary: record.manifest.summary, sources }), "workflow_improved", `improve-held:${record.id}:${next.taskId}`, [{ label: t("去待确认"), href: "/approvals#assistant" }], now);
}

/**
 * Settles the revisions waiting for the person, every pass: the run's result accepted by the person puts the revision in force, as long
 * as its files are still exactly those that passed and the workflow has not moved on; returned, put away unreviewed or changed, it is
 * dropped. Nothing is asked of a model: the checks ran before it waited.
 */
export function applyPendingRevisions(store: CrosslineStore, workspaceId: string, now = new Date()): Array<{ id: string; state: "revised" | "dropped"; reason?: string }> {
  const t = tFor(localeOf(store, workspaceId));
  const out: Array<{ id: string; state: "revised" | "dropped"; reason?: string }> = [];
  const runs = listAgentTasks(store, workspaceId, now);
  for (const record of readGrownSkills(store, workspaceId)) {
    const pending = record.pendingRevision;
    if (!pending) continue;
    const run = runs.find((item) => item.taskId === pending.taskId);
    const accepted = run?.status === "accepted" && run.reviewedBy === "person";
    // Accepted by the daily pass in the person's place (date-advance.ts) is not the person's accept: the revision is dropped, as one put away.
    const declined = !run || run.status === "rejected" || Boolean(run.settled) || run.filesGone || (run.status === "accepted" && run.reviewedBy !== "person");
    if (!accepted && !declined) continue;
    const clear = () => writeGrownSkills(store, workspaceId, readGrownSkills(store, workspaceId).map((item) => {
      if (item.id !== record.id) return item;
      const { pendingRevision: _done, ...rest } = item;
      return rest;
    }));
    const drop = (reason: string) => {
      clear();
      store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.grown.revision_rejected:${record.id}:${pending.taskId}`,
        type: "skill.grown.revision_rejected", entityId: record.id, payload: { id: record.id, reason, taskId: pending.taskId, untrusted: pending.untrusted } });
      out.push({ id: record.id, state: "dropped", reason });
    };
    if (declined) { drop(run?.status === "rejected" ? "person_declined" : "not_reviewed"); continue; }
    if ((record.version ?? 1) !== pending.fromVersion) { drop("version_changed"); continue; }
    const read = readSkillDir(path.join(pending.directory, "skill"), t);
    const files = read.files.filter((file) => file.path !== "CHANGES.md");
    if (read.problem || revisionDigest(files) !== pending.digest) { drop("files_changed"); continue; }
    let manifest: WorkflowManifest;
    try {
      const raw = JSON.parse(files.find((file) => file.path === "workflow.json")?.text ?? "null") as unknown;
      manifest = { ...validateWorkflowManifest(raw, identityLines(store, workspaceId).map((line) => line.id)), lines: record.manifest.lines,
        name: record.manifest.name, category: record.manifest.category };
    } catch { drop("manifest_invalid"); continue; }
    const scan = scanForDeclaredAccess(scanSkillFiles(files), manifest.access.length > 0);
    clear();
    const revised = reviseGrownSkill(store, workspaceId, record.id, { manifest, files, scan, review: { ...pending.review, final: finalVerdict(scan, pending.review) },
      changes: pending.changes, taskId: pending.taskId }, now);
    if (!revised) { out.push({ id: record.id, state: "dropped", reason: "removed" }); continue; }
    out.push({ id: record.id, state: "revised" });
    const values = { summary: record.manifest.summary, version: revised.version };
    sayToPerson(store, workspaceId, revised.needsConsent
      ? t("工作流「{{summary}}」的修订已按本人的采纳生效（第 {{version}} 版）；改后要读的内容或风险有变，请本人重新看过风险再启用。", values)
      : t("工作流「{{summary}}」的修订已按本人的采纳生效（第 {{version}} 版），下次运行就按新版做。", values),
      "workflow_improved", `improved:${record.id}:${revised.version}`, [{ label: t("查看或回到上一版"), href: `/automation/${encodeURIComponent(record.id)}` }], now);
  }
  return out;
}

/**
 * One pass over a workspace's workflows: the first one with a reason to change is revised by the assistant (one revision at a time per
 * workspace). `spend` says whether the quota allows it: what the person said is their own work; failures alone are the system's idea.
 */
const improving = new Set<string>();
export function workflowImprovePass(store: CrosslineStore, workspaceId: string, runFree: RunFree,
  deps: { client: () => CodexRpcBoundary | undefined; cwd: string; workRoot: string; spend: (kind: "core" | "discretionary") => boolean; now?: Date }): string | undefined {
  if (improving.has(workspaceId)) return undefined;
  const now = deps.now ?? new Date();
  for (const settled of applyPendingRevisions(store, workspaceId, now)) console.info(JSON.stringify({ type: `skill.grown.pending_${settled.state}`, workspaceId, ...settled }));
  for (const record of readGrownSkills(store, workspaceId)) {
    const signals = improvementDue(store, workspaceId, record, now);
    if (!signals || !deps.spend(signals.some(fromPerson) ? "core" : "discretionary")) continue;
    const taskId = `${improveTaskPrefix(record.id)}${now.getTime().toString(36)}`;
    // The files in force as a read-only input (scripts included, whatever the scan allowed to run: the revision may fix them).
    const current = path.join(deps.workRoot, workspaceId, taskId);
    rmSync(current, { recursive: true, force: true });
    const files = storedFiles(store, workspaceId, record.id);
    // A workflow Crossline installed itself (the favourites by topic) keeps its manifest in the record only: it goes in as workflow.json,
    // or the revision has none to start from (2026-10-24: 「workflow.json 不是对象」).
    if (!files.some((file) => file.path === "workflow.json")) files.push({ path: "workflow.json", text: JSON.stringify(record.manifest, null, 2) });
    for (const file of files) {
      const target = path.join(current, "skill", file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.text);
    }
    // A workflow merged into this one: its files beside, so what only it did can be folded in.
    for (const absorbed of new Set(signals.flatMap((signal) => signal.absorbed ? [signal.absorbed] : [])))
      for (const file of storedFiles(store, workspaceId, absorbed)) {
        const target = path.join(current, "absorbed", absorbed, file.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, file.text);
      }
    const results = listAgentTasks(store, workspaceId).filter((run) => run.taskId.startsWith(workflowRunPrefix(record.id)) && run.directory && run.status !== "running")
      .slice(-2).map((run) => run.directory);
    // Judged before the run: what the folders it is handed hold decides whether its revision may go in force by itself.
    const untrusted = revisionTaint(store, workspaceId, results);
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.grown.improve_started:${taskId}`, type: "skill.grown.improve_started",
      entityId: record.id, payload: { id: record.id, taskId, signals: signals.map((signal) => signal.kind), ...(untrusted.length ? { untrusted } : {}) } });
    improving.add(workspaceId);
    const started = runFree(improveTask(record, current, signals, results, taskId, localeOf(store, workspaceId)), (outcome) => {
      // What the improving run itself read counts too: a revision written after it read mail or a page is held like one from such folders.
      const read = [...new Set([...untrusted, ...completedTaint(store, workspaceId, taskId)])];
      void installRevision(store, workspaceId, record, outcome, { client: deps.client(), cwd: deps.cwd, untrusted: read })
        .then((result) => console.info(JSON.stringify({ type: `skill.grown.improve_${result.state}`, workspaceId, id: record.id, ...result })))
        .catch(() => undefined).finally(() => improving.delete(workspaceId));
    });
    if (started.state !== "started") improving.delete(workspaceId);
    return started.state === "started" ? record.id : undefined;
  }
  return undefined;
}

/** Every file of a workflow as stored, scripts included (`installedGrownFiles` leaves out scripts the person has not allowed). */
function storedFiles(store: CrosslineStore, workspaceId: string, id: string): Array<{ path: string; text: string }> {
  try { return (JSON.parse(store.getSetting(workspaceId, grownSkillFilesKey(id)) ?? "{}") as { files?: Array<{ path: string; text: string }> }).files ?? []; }
  catch { return []; }
}
