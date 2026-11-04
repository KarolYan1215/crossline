import { existsSync } from "node:fs";
import path from "node:path";
import { SELF_CHECK_DAY_SETTING, SELF_CHECK_EVENT, SELF_CHECK_FEATURES, SELF_CHECK_SETTING, tellKey, type CheckResult } from "@crossline/core";
import { AGENT_FILES_CHECKED, listAgentTasks, type CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";
import { tOfWorkspace } from "./locale";
import { sayToPerson } from "./workflow-smith";

/** What a probe finds: ok, put right by itself (`repaired`), or still wrong (`failing`); `skipped` when the feature is not in use here. */
export type ProbeOutcome = Omit<CheckResult, "id" | "at">;
export type Probe = { id: string; run: (workspaceId: string, now: Date) => ProbeOutcome | Promise<ProbeOutcome> };

const ok: ProbeOutcome = { status: "ok", code: "", detail: "" };
const skipped: ProbeOutcome = { status: "skipped", code: "", detail: "" };

/**
 * Once a day per account (or now, from 系统体检's 「立即自检」): every probe runs, each result is kept in `selfcheck.last` and the ledger, and
 * a failure the probe could not put right is said to the person once a week per feature and code. A probe that throws is a failure of
 * its own (`PROBE_FAILED`), never a reason to skip the rest.
 */
export async function selfCheckPass(store: CrosslineStore, workspaceId: string, probes: Probe[], options: { now?: Date; force?: boolean } = {}): Promise<CheckResult[] | undefined> {
  const now = options.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  if (!options.force && store.getSetting(workspaceId, SELF_CHECK_DAY_SETTING) === today) return undefined;
  store.setSetting(workspaceId, SELF_CHECK_DAY_SETTING, today);
  const at = now.toISOString();
  const results: CheckResult[] = [];
  for (const probe of probes) {
    let outcome: ProbeOutcome;
    try { outcome = await probe.run(workspaceId, now); } catch (error) {
      outcome = { status: "failing", code: "PROBE_FAILED", detail: (error instanceof Error ? error.message : String(error)).slice(0, 300) };
    }
    results.push({ id: probe.id, ...outcome, at });
  }
  store.setSetting(workspaceId, SELF_CHECK_SETTING, JSON.stringify({ at, results }));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `${SELF_CHECK_EVENT}:${at}`, type: SELF_CHECK_EVENT, entityId: workspaceId,
    payload: { results: results.filter((result) => result.status !== "ok" && result.status !== "skipped") } });
  const t = tOfWorkspace(store, workspaceId);
  for (const result of results.filter((item) => item.status === "failing")) {
    const feature = t(SELF_CHECK_FEATURES[result.id] ?? result.id);
    sayToPerson(store, workspaceId, t("自检发现「{{feature}}」有问题，系统没能自动修好：{{detail}}", { feature, detail: result.detail || result.code }),
      "self_check", tellKey(result, today), [{ label: t("看系统体检"), href: "/settings#usage" }], now);
  }
  return results;
}

/** Path of a run folder made on another machine: its last segment under this machine's output root, whichever separator it used. */
const lastSegment = (directory: string) => directory.split(/[\\/]+/).filter(Boolean).at(-1) ?? "";

/**
 * 助手产出 (W-143): every delivered run's folder and files. A folder recorded on another machine (the resident Windows copy before the
 * hosted site became the one ledger) is looked for under this machine's root; found, the run points there. Files that are nowhere are
 * taken off every surface (`agent.task.files_checked`: the output folder, the day view, the block-start nudge, the review list, the zip
 * and the planner's "already made" check all read `artifacts` and `filesGone`), so no link answers FILE_NOT_FOUND and the planner may
 * make the deliverable again. Lost files cannot be made to come back; that is said in the detail, not as a failure.
 */
export function outputsProbe(store: CrosslineStore, root: string, env: NodeJS.ProcessEnv = process.env): Probe {
  return { id: "outputs", run: (workspaceId) => {
    const t = tOfWorkspace(store, workspaceId);
    if (env.CROSSLINE_PUBLIC_BETA === "1" && !env.CROSSLINE_AI_OUTPUT_DIR) {
      // The worker would write under its own container's home, which the web never sees and a redeploy deletes.
      return { status: "failing", code: "OUTPUT_ROOT_UNSET", detail: t("服务器没有设置助手产出的共享目录，新文件网页上下载不到") };
    }
    const rows = listAgentTasks(store, workspaceId).filter((row) => (row.status === "accepted" || row.status === "needs_review") && row.directory && !row.filesGone && row.artifacts.length);
    if (!rows.length) return skipped;
    let moved = 0, gone = 0, missingFiles = 0;
    const owner = ownerOf(store, workspaceId);
    for (const row of rows) {
      let directory = row.directory;
      if (!existsSync(path.join(directory, "audit.json"))) {
        const here = [path.join(root, lastSegment(directory)), path.join(root, row.taskId)].find((candidate) => existsSync(path.join(candidate, "audit.json")));
        if (here) { directory = here; moved++; }
        else {
          gone++;
          store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `${AGENT_FILES_CHECKED}:${row.taskId}:gone`, type: AGENT_FILES_CHECKED, entityId: row.taskId,
            payload: { gone: true, missing: row.artifacts.map((artifact) => artifact.path) } });
          continue;
        }
      }
      const missing = row.artifacts.filter((artifact) => !existsSync(path.join(directory, artifact.path))).map((artifact) => artifact.path);
      missingFiles += missing.length;
      if (directory === row.directory && !missing.length) continue;
      store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `${AGENT_FILES_CHECKED}:${row.taskId}:${directory}:${missing.join("|")}`, type: AGENT_FILES_CHECKED,
        entityId: row.taskId, payload: { ...(directory !== row.directory ? { directory } : {}), missing, gone: missing.length === row.artifacts.length } });
    }
    if (!moved && !gone && !missingFiles) return ok;
    return { status: "repaired", code: gone ? "OUTPUT_DIR_MISSING" : missingFiles ? "OUTPUT_FILE_MISSING" : "OUTPUT_DIR_FOREIGN",
      detail: t("找回 {{moved}} 次运行的文件夹；{{gone}} 次运行和另外 {{files}} 个文件已不在这台机器上，已从产出、日程和提醒里去掉它们的链接", { moved, gone, files: missingFiles }) };
  } };
}
