import {
  AGENT_HISTORY_CONSENT, AGENT_HISTORY_SUMMARY, AI_TOOLS_SETTING, RUNTIME_OWNER_SETTING, GROWN_LIBRARY_SETTING, SKILL_LIBRARY_SETTING, allAiTools, detectedAiTools, personAiTool, readPersonAiTools, categoryFromWording, grownSkillFilesKey, grownSkillId, isScriptFile, mineSkillSettingKey, publicSkillFilesKey, scriptsAllowable, scriptsDigest, scriptsRunnable,
  readGrownLibrary, readMineSkill, readSkillLibrary,
  type AiTool, type GrownSkillRecord, type PublicSkillRecord, type StoredMineSkill, type Weekday, type WorkflowSchedule
} from "@crossline/core";
import { randomUUID } from "node:crypto";
import type { CrosslineStore } from "./index";
import { listAgentTasks } from "./agent";

/**
 * The skill library's ledger side (docs/skills-library.md), shared by the worker that writes it and the settings page where the person
 * edits, restores and removes: the person's line skills as versions in `skills.mine.<line>`, the public ones in `skills.library`.
 */
const ownerOf = (store: CrosslineStore, workspaceId: string) => store.getWorkspaceOwnerId(workspaceId) ?? "system";

/** Appends a version of a line's own skill and makes it current; the old ones stay, and the system never removes one. Returns its number. */
export function saveMineVersion(store: CrosslineStore, workspaceId: string, lineId: string,
  version: Omit<StoredMineSkill["versions"][number], "version">): number {
  const stored = readMineSkill(store.getSetting(workspaceId, mineSkillSettingKey(lineId))) ?? { lineId, current: 0, versions: [] };
  const number = Math.max(0, ...stored.versions.map((item) => item.version)) + 1;
  const next: StoredMineSkill = { lineId, current: number, versions: [...stored.versions, { ...version, version: number }] };
  store.setSetting(workspaceId, mineSkillSettingKey(lineId), JSON.stringify(next));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.mine:${lineId}:v${number}`, type: "skill.mine.rewritten", entityId: lineId,
    payload: { lineId, version: number, by: version.by, rules: version.rules?.length ?? 0, ...(version.fingerprint ? { fingerprint: version.fingerprint } : {}),
      ...(version.restoredFrom ? { restoredFrom: version.restoredFrom } : {}) } });
  return number;
}

export const readPublicSkills = (store: CrosslineStore, workspaceId: string) => readSkillLibrary(store.getSetting(workspaceId, SKILL_LIBRARY_SETTING));
export const writePublicSkills = (store: CrosslineStore, workspaceId: string, records: PublicSkillRecord[]) =>
  store.setSetting(workspaceId, SKILL_LIBRARY_SETTING, JSON.stringify(records));

/** The files installed for a public skill: everything fetched, or — for one allowed only as text, until the person allows its scripts — everything but them. */
export function installedPublicFiles(store: CrosslineStore, workspaceId: string, record: PublicSkillRecord): Array<{ path: string; text: string }> {
  let stored: { files?: Array<{ path: string; text: string }> } | undefined;
  try { stored = JSON.parse(store.getSetting(workspaceId, publicSkillFilesKey(record.id)) ?? "{}") as typeof stored; } catch { stored = undefined; }
  const scripts = scriptsRunnable(record);
  return (stored?.files ?? []).filter((file) => scripts || !isScriptFile(file.path));
}

export const readGrownSkills = (store: CrosslineStore, workspaceId: string) => readGrownLibrary(store.getSetting(workspaceId, GROWN_LIBRARY_SETTING));
export const writeGrownSkills = (store: CrosslineStore, workspaceId: string, records: GrownSkillRecord[]) =>
  store.setSetting(workspaceId, GROWN_LIBRARY_SETTING, JSON.stringify(records));

/**
 * The one line a grown workflow belongs to: the line of the request it was grown from, or of the errands it repeats. A workflow is used
 * only on that line — a media workflow whose manifest also named research was switched on for a course-material errand (2026-10-14).
 * Records written since carry it as their only line; older ones are read from their origin. Undefined when the origin says nothing.
 */
export function grownHomeLine(store: CrosslineStore, workspaceId: string, record: GrownSkillRecord): string | undefined {
  if (record.origin.kind === "asked") {
    const asked = store.listEvents(workspaceId, { type: "workflow.requested", entityId: record.origin.requestId }).at(-1);
    const line = (asked?.payload as { lineId?: string } | undefined)?.lineId;
    return line || (record.lines.length === 1 ? record.lines[0] : undefined);
  }
  const taskIds = new Set(record.origin.taskIds);
  const orderId = listAgentTasks(store, workspaceId).find((task) => taskIds.has(task.taskId) && task.workOrderId)?.workOrderId;
  return (orderId ? store.listWorkOrders(workspaceId).find((order) => order.id === orderId)?.identityId : undefined)
    ?? (record.lines.length === 1 ? record.lines[0] : undefined);
}

/** A grown workflow's files: all of them, or — when the scan or the review allowed it only as text and the person has not allowed its scripts — all but them. */
export function installedGrownFiles(store: CrosslineStore, workspaceId: string, record: GrownSkillRecord): Array<{ path: string; text: string }> {
  let stored: { files?: Array<{ path: string; text: string }> } | undefined;
  try { stored = JSON.parse(store.getSetting(workspaceId, grownSkillFilesKey(record.id)) ?? "{}") as typeof stored; } catch { stored = undefined; }
  const scripts = scriptsRunnable(record);
  return (stored?.files ?? []).filter((file) => scripts || !isScriptFile(file.path));
}

/**
 * The person allows a skill's scripts after reading the scan, or takes the leave back (`skill.scripts_allowed`, with what the scan found
 * and the files it covers). Only for a skill the checks capped to text; one they refused stays refused. The worker reinstalls the plugin
 * on its next run, since the files it installs changed.
 */
export function allowSkillScripts(store: CrosslineStore, workspaceId: string, kind: "public" | "grown", id: string, allow: boolean, now = new Date()): boolean {
  const at = now.toISOString();
  const change = <T extends PublicSkillRecord | GrownSkillRecord>(records: T[], write: (next: T[]) => void): T | undefined => {
    const record = records.find((item) => item.id === id);
    if (!record || !scriptsAllowable(record) || (!allow && !record.scriptsAllowed)) return undefined;
    write(records.map((item) => {
      if (item.id !== id) return item;
      const { scriptsAllowed: _old, ...rest } = item;
      return (allow ? { ...rest, scriptsAllowed: { at, digest: scriptsDigest(item.files) }, updatedAt: at } : { ...rest, updatedAt: at }) as T;
    }));
    return record;
  };
  const record = kind === "public" ? change(readPublicSkills(store, workspaceId), (next) => writePublicSkills(store, workspaceId, next))
    : change(readGrownSkills(store, workspaceId), (next) => writeGrownSkills(store, workspaceId, next));
  if (!record) return false;
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.scripts:${kind}:${id}:${at}`, type: allow ? "skill.scripts_allowed" : "skill.scripts_revoked",
    entityId: id, payload: { id, kind, files: record.files.filter((file) => isScriptFile(file.path)).map((file) => file.path),
      findings: record.scan.findings.map((finding) => `${finding.file}:${finding.line} ${finding.rule}`).slice(0, 20) } });
  return true;
}

/** The person turns a grown workflow off or on, or keeps it (`pinned`: never removed for being idle). */
export function updateGrownSkill(store: CrosslineStore, workspaceId: string, id: string, patch: { status?: "active" | "off"; pinned?: boolean },
  now = new Date()): boolean {
  const records = readGrownSkills(store, workspaceId);
  const record = records.find((item) => item.id === id);
  if (!record) return false;
  // One that reads an account is switched on only by accepting its risks (`consentToGrownSkill`), never by the plain on/off.
  if (patch.status === "active" && record.status === "needs_consent") return false;
  writeGrownSkills(store, workspaceId, records.map((item) => item.id === id ? { ...item, ...patch, updatedAt: now.toISOString() } : item));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.grown.updated:${id}:${now.toISOString()}`, type: "skill.grown.updated",
    entityId: id, payload: { id, ...patch } });
  return true;
}

/**
 * The person accepted the risks of a workflow that reads their account or a site (docs/skills-library.md §6): it is switched on and the
 * acceptance recorded with the risks it was shown, so a later change of what it reads can be told apart from what was agreed to.
 */
export function consentToGrownSkill(store: CrosslineStore, workspaceId: string, id: string, now = new Date()): boolean {
  const records = readGrownSkills(store, workspaceId);
  const record = records.find((item) => item.id === id);
  if (!record || record.status !== "needs_consent") return false;
  const at = now.toISOString();
  writeGrownSkills(store, workspaceId, records.map((item) => item.id === id ? { ...item, status: "active" as const, consentedAt: at, updatedAt: at } : item));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.grown.consented:${id}:${at}`, type: "skill.grown.consented",
    entityId: id, payload: { id, access: record.manifest.access ?? [], risks: record.manifest.risks ?? [] } });
  return true;
}

/** Records that the person finished logging in to a service a workflow reads (the browser window they logged in with was closed). */
export function recordGrownLogin(store: CrosslineStore, workspaceId: string, id: string, service: string, now = new Date(), browser = ""): void {
  const at = now.toISOString();
  writeGrownSkills(store, workspaceId, readGrownSkills(store, workspaceId).map((item) => item.id === id ? { ...item, logins: { ...(item.logins ?? {}), [service]: at },
    ...(browser ? { loginBrowsers: { ...(item.loginBrowsers ?? {}), [service]: browser } } : {}) } : item));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.grown.logged_in:${id}:${at}`, type: "skill.grown.logged_in",
    entityId: id, payload: { id, service } });
}

/** Removes a grown workflow and its files (`skill.grown.removed` keeps why and by whom). */
export function removeGrownSkill(store: CrosslineStore, workspaceId: string, id: string, reason: string, by: "system" | "person", now = new Date()): boolean {
  const records = readGrownSkills(store, workspaceId);
  const record = records.find((item) => item.id === id);
  if (!record) return false;
  writeGrownSkills(store, workspaceId, records.filter((item) => item.id !== id));
  store.deleteSetting(workspaceId, grownSkillFilesKey(id));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.grown.removed:${id}:${now.toISOString()}`, type: "skill.grown.removed",
    entityId: id, payload: { id, name: record.name, reason, by } });
  return true;
}

/** Removes a public skill and its files (the record of why stays in `skill.public.removed`). The person's line skills are never removed. */
export function removePublicSkill(store: CrosslineStore, workspaceId: string, id: string, reason: string, by: "system" | "person", now = new Date()): boolean {
  const records = readPublicSkills(store, workspaceId);
  const record = records.find((item) => item.id === id);
  if (!record) return false;
  writePublicSkills(store, workspaceId, records.filter((item) => item.id !== id));
  store.deleteSetting(workspaceId, publicSkillFilesKey(id));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.public.removed:${id}:${now.toISOString()}`, type: "skill.public.removed",
    entityId: id, payload: { id, name: record.name, repo: record.source.repo, path: record.source.path, commit: record.commit, reason, by } });
  return true;
}

const DAY_OF_INDEX: Weekday[] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/**
 * A reminder the person set in words (「每周五下午六点提醒我发小红书」): a remind-only workflow written at once, with no assistant run and
 * nothing to install — there is no method to write down, only a time and the words to say. `weekdays` are 0 (Sunday) to 6; none is every day.
 */
export function createReminderWorkflow(store: CrosslineStore, workspaceId: string,
  input: { text: string; reminder: string; time: string; weekdays: number[]; lineId: string }, now = new Date()): GrownSkillRecord {
  const days = [...new Set(input.weekdays.filter((day) => day >= 0 && day <= 6))].sort().map((day) => DAY_OF_INDEX[day]!);
  const schedule: WorkflowSchedule = !days.length || days.length === 7 ? { type: "daily", time: input.time }
    : days.length === 5 && !days.includes("SA") && !days.includes("SU") ? { type: "weekdays", time: input.time } : { type: "weekly", days, time: input.time };
  const records = readGrownSkills(store, workspaceId);
  const id = grownSkillId(`reminder-${input.time.replace(":", "")}`, records.map((record) => record.id));
  const at = now.toISOString();
  const record: GrownSkillRecord = { id, kind: "grown", name: id.replace(/^flow-/, ""), description: input.reminder, lines: input.lineId ? [input.lineId] : [],
    category: "files_calendar_prep",
    manifest: { name: id.replace(/^flow-/, ""), summary: input.reminder, lines: input.lineId ? [input.lineId] : [], category: "files_calendar_prep", trigger: "schedule",
      schedule, action: "remind", reminder: input.reminder, steps: [{ title: input.reminder, by: "person", external: false }], inputs: [], outputs: [], access: [], risks: [] },
    origin: { kind: "asked", text: input.text, requestId: `reminder-${id}` }, taskId: "", files: [],
    scan: { risk: "low", injection: false, findings: [] }, review: { verdict: "usable", reasons: ["本人在输入框里设的提醒，没有脚本"], final: "usable" },
    status: "active", pinned: true, createdAt: at, updatedAt: at, lastUsedAt: at };
  writeGrownSkills(store, workspaceId, [...records, record]);
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `skill.grown.created:${id}`, type: "skill.grown.created", entityId: id,
    payload: { id, name: record.name, trigger: "schedule", schedule, action: "remind", origin: "asked" } });
  return record;
}

/** The person asked, in words, for a workflow (「以后每周五把素材剪成一条 vlog」): recorded for the worker's next growing pass. Returns its id. */
export function requestWorkflow(store: CrosslineStore, workspaceId: string, text: string, lineId: string, ownerId: string): string {
  const id = `wfreq-${randomUUID().slice(0, 8)}`;
  const category = categoryFromWording(text);
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: `workflow.requested:${id}`, type: "workflow.requested", entityId: id,
    payload: { text: text.slice(0, 1000), lineId, ...(category ? { category } : {}) } });
  return id;
}

/**
 * The AI tools this person works with (docs/skills-library.md §7): the system's own assistant and research, Codex and Claude Code when
 * their logs show use (only while the person allowed reading them), and the tools the person named. Plans, tutorials and workflows read this.
 */
export function aiToolsFor(store: CrosslineStore, workspaceId: string): AiTool[] {
  let summary: { folders?: Array<{ codex: number; claude: number }> } | undefined;
  if (store.getSetting(workspaceId, AGENT_HISTORY_CONSENT) === "on") {
    try { summary = JSON.parse(store.getSetting(workspaceId, AGENT_HISTORY_SUMMARY) ?? "null") ?? undefined; } catch { summary = undefined; }
  }
  const tools = allAiTools(store.getSetting(workspaceId, AI_TOOLS_SETTING), detectedAiTools(summary));
  // Every account has the assistant now (docs/personal-agent.md, 2026-10-19): the owner's with a shell, everyone else's through
  // Crossline's own functions — which cannot run scripts or edit media, so its line says what it does there.
  const mode = assistantMode(store, workspaceId);
  return mode === "shell" ? tools
    : tools.map((tool) => tool.id === "crossline-assistant" ? { ...tool, goodFor: mode === "sandbox" ? SANDBOX_ASSISTANT_GOOD_FOR : TOOLS_ASSISTANT_GOOD_FOR } : tool);
}

/** Where the server runs the shell in Codex's Linux sandbox: scripts and data work, without network in its commands. */
export const SANDBOX_ASSISTANT_GOOD_FOR = "整份做琐事：汇集整理材料、起草、数据处理与脚本（在沙箱里运行）、联网查证、读邮箱、定期跑自动化；不发送不发布";

/** What the assistant does where it has no shell: reading, writing and organising, the web, the mailbox; not scripts or media. */
export const TOOLS_ASSISTANT_GOOD_FOR = "整份做琐事：汇集与整理材料、起草文档与表格、联网查证、读邮箱找信息、定期跑自动化；不运行脚本、不剪辑，不发送不发布";

/**
 * How the assistant works for this workspace: `shell` on the machine owner's own Codex (everything the computer can do, behind the
 * guard), `tools` for everyone else — Crossline's own functions (agent-tools.ts), on whatever model serves the account.
 */
export function assistantMode(store: CrosslineStore, workspaceId: string, env: NodeJS.ProcessEnv = process.env): "shell" | "sandbox" | "tools" {
  // `sandbox` as the server configured it; the worker falls back to tools by itself when a sandbox does not start (sandbox-probe.ts).
  return assistantAvailable(store, workspaceId, env) ? "shell" : env.CROSSLINE_SANDBOX_SHELL?.trim() === "on" && process.platform === "linux" ? "sandbox" : "tools";
}

/**
 * Whether this workspace has the machine's assistant: it is the runtime owner, or no workspace has been marked owner yet. Never on the
 * hosted beta (`CROSSLINE_PUBLIC_BETA=1`): there the machine is a server every account's ledger sits on, and a shell guarded by a
 * tripwire, not a sandbox, would reach all of them (found walking app.crossline.lol as its owner, 2026-10-16).
 */
export function assistantAvailable(store: CrosslineStore, workspaceId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CROSSLINE_PUBLIC_BETA === "1") return false;
  if (store.getSetting(workspaceId, RUNTIME_OWNER_SETTING) === "1") return true;
  return !store.listWorkspaces().some((workspace) => store.getSetting(workspace.id, RUNTIME_OWNER_SETTING) === "1");
}

/** The person names a tool they use (「剪映：自动字幕、粗剪」); returns it, or undefined for an empty name. */
export function addAiTool(store: CrosslineStore, workspaceId: string, input: { name: string; kind: string; goodFor: string }): AiTool | undefined {
  const current = readPersonAiTools(store.getSetting(workspaceId, AI_TOOLS_SETTING));
  const tool = personAiTool(input, aiToolsFor(store, workspaceId).map((item) => item.id));
  if (!tool) return undefined;
  store.setSetting(workspaceId, AI_TOOLS_SETTING, JSON.stringify([...current.filter((item) => item.name.toLowerCase() !== tool.name.toLowerCase()), tool]));
  return tool;
}

export function removeAiTool(store: CrosslineStore, workspaceId: string, id: string): boolean {
  const current = readPersonAiTools(store.getSetting(workspaceId, AI_TOOLS_SETTING));
  if (!current.some((tool) => tool.id === id)) return false;
  store.setSetting(workspaceId, AI_TOOLS_SETTING, JSON.stringify(current.filter((tool) => tool.id !== id)));
  return true;
}
