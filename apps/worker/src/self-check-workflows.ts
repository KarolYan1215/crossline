import { createHash } from "node:crypto";
import { WORKFLOW_FEEDBACK_EVENT, grownSkillFilesKey, widensAgreed, type GrownSkillRecord } from "@crossline/core";
import { agreedScope, readGrownSkills, readGrownVersions, writeGrownSkills, type CrosslineStore } from "@crossline/db";
import { ownerOf } from "./owner";
import { tOfWorkspace } from "./locale";
import type { Probe, ProbeOutcome } from "./self-check";

/** A merge's reason given up on (its absorbed workflow no longer merged into the kept one): the reviser is not asked to take it over. */
export const ABSORB_DROPPED_EVENT = "skill.grown.absorb_dropped";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const storedFiles = (store: CrosslineStore, workspaceId: string, id: string): Array<{ path: string; text: string }> => {
  try { return (JSON.parse(store.getSetting(workspaceId, grownSkillFilesKey(id)) ?? "{}") as { files?: Array<{ path: string; text: string }> }).files ?? []; }
  catch { return []; }
};

/**
 * 自建工作流 (the self-check's `workflows` probe): what the record says a workflow is against what is stored, per workspace. Files whose
 * hashes no longer match and versions out of order are only reported; a merge into a workflow that is gone or merged away, a workflow
 * waiting for consent although it is back within what the person agreed to, and a merge reason left after the merge was undone are put
 * right. No model call.
 */
export function workflowsProbe(store: CrosslineStore): Probe {
  return { id: "workflows", run: (workspaceId, now) => {
    const records = readGrownSkills(store, workspaceId);
    if (!records.length) return { status: "skipped", code: "", detail: "" };
    const t = tOfWorkspace(store, workspaceId);
    const byId = new Map(records.map((record) => [record.id, record]));
    const drift: string[] = [], disorder: string[] = [];
    for (const record of records) {
      const stored = new Map(storedFiles(store, workspaceId, record.id).map((file) => [file.path, sha(file.text)]));
      if (stored.size !== record.files.length || record.files.some((file) => stored.get(file.path) !== file.sha256)) drift.push(record.manifest.summary || record.id);
      const numbers = [...readGrownVersions(store, workspaceId, record.id).map((version) => version.version), record.version ?? 1];
      if (numbers.some((number, index) => index > 0 && number <= numbers[index - 1]!)) disorder.push(record.manifest.summary || record.id);
    }
    // Repairs, written once at the end.
    let unmerged = 0, reactivated = 0;
    const at = now.toISOString();
    const next: GrownSkillRecord[] = records.map((record) => {
      if (record.mergedInto) {
        const target = byId.get(record.mergedInto.id);
        if (!target || target.mergedInto) {
          unmerged += 1;
          const { mergedInto, ...rest } = record;
          return { ...rest, status: mergedInto.status, updatedAt: at };
        }
      }
      if (record.status === "needs_consent") {
        const agreed = agreedScope(store, workspaceId, record);
        if (agreed && !widensAgreed(agreed, record.manifest)) { reactivated += 1; return { ...record, status: "active" as const, updatedAt: at }; }
      }
      return record;
    });
    if (unmerged || reactivated) writeGrownSkills(store, workspaceId, next);
    // A merge's reason whose absorbed workflow is no longer merged into the kept one, and that nothing has given up on yet.
    let dropped = 0;
    const owner = ownerOf(store, workspaceId);
    const settled = (keep: string, absorbed: string, since: string) => [...store.listEvents(workspaceId, { type: "skill.grown.unmerged", entityId: keep }),
      ...store.listEvents(workspaceId, { type: ABSORB_DROPPED_EVENT, entityId: keep })]
      .some((event) => (event.payload as { absorbed?: string }).absorbed === absorbed && event.createdAt >= since);
    for (const record of next) {
      const since = record.improvedAt ?? record.createdAt;
      for (const event of store.listEvents(workspaceId, { type: WORKFLOW_FEEDBACK_EVENT, entityId: record.id })) {
        const absorbed = (event.payload as { absorbed?: string }).absorbed;
        if (!absorbed || event.createdAt <= since) continue;
        if (next.find((item) => item.id === absorbed)?.mergedInto?.id === record.id || settled(record.id, absorbed, event.createdAt)) continue;
        dropped += 1;
        store.appendEvent({ ownerId: owner, workspaceId, idempotencyKey: `${ABSORB_DROPPED_EVENT}:${record.id}:${absorbed}:${event.eventId}`, type: ABSORB_DROPPED_EVENT,
          entityId: record.id, payload: { id: record.id, absorbed, by: "self_check" } });
      }
    }
    if (drift.length || disorder.length) {
      return { status: "failing", code: drift.length ? "WF_FILES_DRIFT" : "WF_VERSION_ORDER",
        detail: [drift.length ? t("工作流「{{names}}」记录的文件和存下的文件对不上", { names: drift.join("、") }) : "",
          disorder.length ? t("工作流「{{names}}」的版本号顺序不对", { names: disorder.join("、") }) : ""].filter(Boolean).join(" ") } satisfies ProbeOutcome;
    }
    if (!unmerged && !reactivated && !dropped) return { status: "ok", code: "", detail: "" };
    return { status: "repaired", code: unmerged ? "WF_MERGE_DANGLING" : reactivated ? "WF_CONSENT_STALE" : "WF_ABSORB_AFTER_UNMERGE",
      detail: t("{{unmerged}} 个工作流合并的去处已不在，已重新启用；{{reactivated}} 个已回到本人同意的范围内，已重新启用；{{dropped}} 条已撤销的合并不再并入", { unmerged, reactivated, dropped }) };
  } };
}
