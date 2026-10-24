import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  WORKFLOW_FEEDBACK_EVENT, classifyAgentFailure, finalVerdict, grownSkillFilesKey, grownSkillName, scanForDeclaredAccess, scanSkillFiles, skillFrontmatter, validateWorkflowManifest,
  type GrownSkillRecord
} from "@crossline/core";
import type { CodexRpcBoundary } from "@crossline/codex";
import { listAgentTasks, readGrownSkills, reviseGrownSkill, writeGrownSkills, type CrosslineStore } from "@crossline/db";
import type { DispatchResult } from "./agent-service";
import type { AgentOutcome, AgentTaskInput } from "./agent-task";
import { identityLines } from "./lines";
import { ownerOf } from "./owner";
import { readSkillDir, reviewWorkflow, sayToPerson, SKILL_CREATOR } from "./workflow-smith";

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
 */
type RunFree = (input: AgentTaskInput & { taskId: string }, after?: (outcome: AgentOutcome | { state: "failed"; message: string }) => void) => DispatchResult;
export type ImprovementSignal = { at: string; kind: "feedback" | "review" | "retry" | "failure"; text: string; taskId?: string };

/** A revision is tried again after this long when the signals it answered are still there (it failed, or found nothing to change). */
export const IMPROVE_COOLDOWN_MS = 6 * 3_600_000;
/** Runs of its own that failed since the last revision before failures alone are a reason to revise. */
export const FAILURES_TO_IMPROVE = 2;
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
  for (const event of store.listEvents(workspaceId, { type: WORKFLOW_FEEDBACK_EVENT, entityId: record.id }))
    if (after(event.createdAt)) signals.push({ at: event.createdAt, kind: "feedback", text: String((event.payload as { text?: string }).text ?? "") });
  for (const event of store.listEvents(workspaceId, { type: "agent.task.reviewed" })) {
    const payload = event.payload as { taskId?: string; note?: string; decision?: string; by?: string };
    if (!String(payload.taskId ?? "").startsWith(prefix) || !payload.note?.trim() || payload.by === "system" || !after(event.createdAt)) continue;
    signals.push({ at: event.createdAt, kind: "review", text: `${payload.decision === "accepted" ? "采纳时的意见" : "退回的理由"}：${payload.note.trim()}`, taskId: payload.taskId! });
  }
  for (const event of store.listEvents(workspaceId, { type: "agent.retry_requested" })) {
    const payload = event.payload as { taskId?: string; note?: string; by?: string };
    if (!String(payload.taskId ?? "").startsWith(prefix) || !payload.note?.trim() || payload.by !== "person" || !after(event.createdAt)) continue;
    signals.push({ at: event.createdAt, kind: "retry", text: `要求重做：${payload.note.trim()}`, taskId: payload.taskId! });
  }
  // A failure of its own (not a restart, a stop, the quota or the site's check, which no change to the workflow answers).
  for (const run of listAgentTasks(store, workspaceId)) {
    if (!run.taskId.startsWith(prefix) || run.status !== "blocked" || !after(run.requestedAt)) continue;
    const failure = classifyAgentFailure(run);
    if (failure.kind !== "hard" && failure.kind !== "needs_input") continue;
    signals.push({ at: run.requestedAt, kind: "failure", text: `运行失败：${failure.stuckAt}`, taskId: run.taskId });
  }
  return signals.sort((a, b) => a.at.localeCompare(b.at));
}

/** Whether to revise it now: something the person said, or failures enough, newer than the cooldown allows, within the tries a set gets. */
export function improvementDue(store: CrosslineStore, workspaceId: string, record: GrownSkillRecord, now = new Date()): ImprovementSignal[] | undefined {
  if (record.status !== "active") return undefined;
  const signals = improvementSignals(store, workspaceId, record);
  const person = signals.filter((signal) => signal.kind !== "failure");
  if (!person.length && signals.length < FAILURES_TO_IMPROVE) return undefined;
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
export function improveTask(record: GrownSkillRecord, current: string, signals: ImprovementSignal[], results: string[], taskId: string): AgentTaskInput & { taskId: string } {
  const lines = signals.slice(-12).map((signal) => `- ${signal.at.slice(0, 10)} ${signal.text.slice(0, 600)}`);
  return {
    taskId, category: record.category, prep: true, extraSkills: [SKILL_CREATOR], lineId: record.lines[0] ?? "", growing: true,
    title: `改进工作流：${record.manifest.summary}`.slice(0, 80), humanPart: "改好后会告诉本人，不合适可回到上一版。",
    inputs: [current, ...results],
    what: [
      `按 $skill-creator 改进工作流「${record.manifest.summary}」（$${grownSkillName(record.id)}）。它现在的文件在只读输入 ${path.basename(current)}/skill/ 里（SKILL.md、workflow.json 和脚本）${results.length ? "，最近几次运行的结果也作为只读输入给你" : ""}。`,
      "要回应的是这些（本人说的优先，其次是运行失败）：", ...lines,
      "在任务目录下写出改好后的完整 skill/ 文件夹（照原样带上不需要改的文件），并写 skill/CHANGES.md：一到五行，说改了什么、对应上面哪一条。",
      "只改这些意见和失败要求改的地方，不加没人要求的功能。workflow.json 的 name、lines、category 不变；不新增要读的网站、登录、风险或离开本机的步骤，除非本人明确要求（那样会请本人重新同意）。发送、上传、发布、付款一类的步骤仍由本人完成。安全规定（不改动账号、遇到验证就停、不伪装浏览器）原样保留。",
      "改了脚本的话，能运行就用离线样例实际跑通；不能运行就只改到读得出确实正确的程度。",
      "上面的意见都不需要改文件就能做到（例如是一次性的要求），或者没法从工作流本身改好（是 Crossline 程序的问题）：不写 skill/，只写 NO_CHANGE.md，一两句说明原因。",
      "这次只改工作流，不执行它本身，不访问需要登录的网站。"
    ].join("\n")
  };
}

/**
 * Reads back what the revising run wrote and puts it in force when it passes the checks a new workflow passes; tells the person either
 * way. A run that judged no change was needed says why and counts as answering the signals.
 */
export async function installRevision(store: CrosslineStore, workspaceId: string, record: GrownSkillRecord, outcome: AgentOutcome | { state: "failed"; message: string },
  deps: { client: CodexRpcBoundary | undefined; cwd: string; now?: () => Date }): Promise<{ state: "revised"; version: number } | { state: "unchanged" | "rejected"; reason: string }> {
  const now = deps.now?.() ?? new Date();
  const ownerId = ownerOf(store, workspaceId);
  const label = `「${record.manifest.summary}」`;
  const reject = (reason: string) => {
    store.appendEvent({ ownerId, workspaceId, idempotencyKey: `skill.grown.revision_rejected:${record.id}:${now.getTime()}`, type: "skill.grown.revision_rejected",
      entityId: record.id, payload: { id: record.id, reason: reason.slice(0, 300) } });
    return { state: "rejected" as const, reason };
  };
  if (outcome.state !== "done") return reject(outcome.state === "failed" || outcome.state === "blocked" ? outcome.message || "运行失败" : "助手未获准做这类工作");
  const read = readSkillDir(path.join(outcome.directory, "skill"));
  if (read.problem) {
    let why = "";
    try { why = readFileSync(path.join(outcome.directory, "NO_CHANGE.md"), "utf8").trim(); } catch { /* none written */ }
    if (why) {
      // Answered without a change: the signals are settled until something new comes (`improvedAt`).
      store.appendEvent({ ownerId, workspaceId, idempotencyKey: `skill.grown.improve_skipped:${record.id}:${now.getTime()}`, type: "skill.grown.improve_skipped",
        entityId: record.id, payload: { id: record.id, why: why.slice(0, 400) } });
      writeGrownSkills(store, workspaceId, readGrownSkills(store, workspaceId).map((item) => item.id === record.id ? { ...item, improvedAt: now.toISOString() } : item));
      sayToPerson(store, workspaceId, `看过对工作流${label}的意见，这次没有改它：${why.slice(0, 200)}`, "workflow_improved", `improve-skip:${record.id}:${now.getTime()}`,
        [{ label: "去看工作流", href: "/settings#skills" }], now);
      return { state: "unchanged", reason: why };
    }
    return reject(read.problem);
  }
  const skillText = read.files.find((file) => file.path === "SKILL.md")?.text ?? "";
  const front = skillFrontmatter(skillText);
  if (!front) return reject("SKILL.md 没有 name 和 description");
  let manifest;
  try {
    const raw = JSON.parse(read.files.find((file) => file.path === "workflow.json")?.text ?? "null") as unknown;
    manifest = { ...validateWorkflowManifest(raw, identityLines(store, workspaceId).map((line) => line.id)), lines: record.manifest.lines,
      name: record.manifest.name, category: record.manifest.category };
  } catch (error) { return reject(`workflow.json 不合格：${(error as Error & { detail?: string }).detail ?? (error as Error).message}`); }
  const scan = scanForDeclaredAccess(scanSkillFiles(read.files), manifest.access.length > 0);
  if (!deps.client) return reject("审查未完成：模型服务不可用");
  const changes = (read.files.find((file) => file.path === "CHANGES.md")?.text ?? "").trim() || "按反馈调整";
  const reviewed = await reviewWorkflow(deps.client, deps.cwd, { name: front.name, description: front.description, origin: "按本人的意见和运行情况修订", why: changes }, manifest, read.files, scan);
  if (!reviewed.ok) return reject(`审查未完成：${reviewed.blocker.message}`);
  const final = finalVerdict(scan, reviewed.output);
  if (final === "reject") return reject(scan.injection ? "SKILL.md 含有要求模型越权或外传的语句" : reviewed.output.reasons.join("；").slice(0, 300));
  const files = read.files.filter((file) => file.path !== "CHANGES.md");
  const revised = reviseGrownSkill(store, workspaceId, record.id, { manifest, files, scan, review: { ...reviewed.output, final }, changes, taskId: outcome.taskId }, now);
  if (!revised) return reject("工作流已被删除");
  sayToPerson(store, workspaceId, `工作流${label}按意见改了（第 ${revised.version} 版）：${changes.replace(/\s*\n+\s*/g, "；").slice(0, 300)}。${revised.needsConsent ? "改后要读的内容或风险有变，请本人重新看过风险再启用。" : "下次运行就按新版做；不合适可在设置里回到上一版。"}`,
    "workflow_improved", `improved:${record.id}:${revised.version}`, [{ label: revised.needsConsent ? "查看风险并启用" : "查看或回到上一版", href: "/settings#skills" }], now);
  return { state: "revised", version: revised.version };
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
  for (const record of readGrownSkills(store, workspaceId)) {
    const signals = improvementDue(store, workspaceId, record, now);
    if (!signals || !deps.spend(signals.some((signal) => signal.kind !== "failure") ? "core" : "discretionary")) continue;
    const taskId = `${improveTaskPrefix(record.id)}${now.getTime().toString(36)}`;
    // The files in force as a read-only input (scripts included, whatever the scan allowed to run: the revision may fix them).
    const current = path.join(deps.workRoot, workspaceId, taskId);
    rmSync(current, { recursive: true, force: true });
    for (const file of storedFiles(store, workspaceId, record.id)) {
      const target = path.join(current, "skill", file.path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, file.text);
    }
    const results = listAgentTasks(store, workspaceId).filter((run) => run.taskId.startsWith(workflowRunPrefix(record.id)) && run.directory && run.status !== "running")
      .slice(-2).map((run) => run.directory);
    store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.grown.improve_started:${taskId}`, type: "skill.grown.improve_started",
      entityId: record.id, payload: { id: record.id, taskId, signals: signals.map((signal) => signal.kind) } });
    improving.add(workspaceId);
    const started = runFree(improveTask(record, current, signals, results, taskId), (outcome) => {
      void installRevision(store, workspaceId, record, outcome, { client: deps.client(), cwd: deps.cwd })
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
