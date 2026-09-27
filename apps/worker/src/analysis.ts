import { runCodexAnalysis, type CodexRpcBoundary } from "@crossline/codex";
import { validateAnalysisContext, type AnalysisContext } from "@crossline/core";
import { CrosslineStore, type StoredCapture } from "@crossline/db";
import { defaultIdentityPacks } from "@crossline/identity-packs";

export type AnalysisOutcome = { id: string; state: string; attempt: number; audit: StoredCapture["audit"] };

const FAMILIES = ["preparation", "review", "deep_work"] as const;

/** How this workspace's own past captures actually turned out, per (identity, family) — evidence the
 * analysis Skill can weigh against its own read of the current capture, not history it must copy.
 * `medianActualMinutes: 0` means no real completions exist yet, the same convention `Estimate.
 * observationCount` already uses for "unobserved". */
function buildHistoricalStats(store: CrosslineStore, workspaceId: string, identityIds: string[]): AnalysisContext["historicalStats"] {
  const promoted = store.listWorkOrders(workspaceId);
  return identityIds.flatMap((identityId) => FAMILIES.map((family) => {
    const chosenCount = promoted.filter((order) => order.identityId === identityId
      && (order.payload as { family?: string } | undefined)?.family === family).length;
    const durations = store.listDurationObservations(workspaceId, identityId, family)
      .map((row) => row.observedMinutes).sort((a, b) => a - b);
    return { identityId, family, chosenCount,
      medianActualMinutes: durations.length ? durations[Math.floor(durations.length / 2)]! : 0 };
  }));
}
// `workspaceId` is the real caller's, fixed at creation — one analyzer per real workspace, the same
// pattern `createMaterialPreparer`/`createMilestoneGate` already use. This used to be a hardcoded
// module-level `"personal-crossline"` plus an `ownerId === "local-owner"` filter on every read, so a
// real account's own captures and milestones were invisible to it: `getCapture` threw
// `CAPTURE_NOT_FOUND` and the milestones filter threw `ANALYSIS_APPROVED_MILESTONE_REQUIRED` even with
// approved milestones on the books, because workspace-scoping already makes the ownerId check redundant
// and wrong for any account that is not that one literal owner.
export function createCaptureAnalyzer(store: CrosslineStore, workspaceId: string, cwd: string) {
  // A new worker cannot safely replay an interrupted turn. Retain its IDs for audit.
  for (const capture of store.listCaptures(workspaceId).filter((item) => item.state === "analyzing")) {
    store.transitionWorkOrder(workspaceId, capture.id, { type: "blocked", reason: "ANALYSIS_RECOVERY_REQUIRED" }, `analysis:${capture.id}:${capture.attempt}:recovery`, {
      audit: { blocker: { code: "ANALYSIS_RECOVERY_REQUIRED", message: "Worker 重启；上一次分析未完成，可重新分析。" } }
    });
  }
  const getCapture = (id: string) => {
    const capture = store.listCaptures(workspaceId).find((item) => item.id === id);
    if (!capture) throw new Error("CAPTURE_NOT_FOUND");
    return capture;
  };
  // Once a capture is promoted its row is only a marked archive of the raw text; the WorkOrder holds
  // the authoritative state, so that is what the caller and the Web boundary are told.
  const outcome = (id: string): AnalysisOutcome => {
    const capture = getCapture(id);
    if (capture.state !== "promoted") return { id, state: capture.state, attempt: capture.attempt, audit: capture.audit };
    const promoted = store.listWorkOrders(workspaceId).find((item) => item.id === id);
    if (!promoted) throw new Error("WORK_ORDER_NOT_FOUND");
    return { id, state: promoted.state, attempt: capture.attempt, audit: capture.audit };
  };
  // The claim below runs before the first await, so the database row is the only lock needed:
  // a concurrent second request reads `analyzing` and returns instead of starting a second turn.
  return async (client: CodexRpcBoundary, id: string, signal?: AbortSignal): Promise<AnalysisOutcome> => {
    const capture = getCapture(id);
    if (capture.state !== "captured" && capture.state !== "blocked") return outcome(id);
    const attempt = capture.state === "blocked" ? capture.attempt + 1 : capture.attempt;
    const claimed = store.transitionWorkOrder(workspaceId, id, { type: "analysis.proposed", proposalId: id }, `analysis:${id}:${attempt}:start`, { attempt });
    if (!claimed.changed) return outcome(id);
    try {
      const milestones = store.listMilestones(workspaceId).filter((m) => m.status === "approved" && m.projectId);
      if (!milestones.length) throw new Error("ANALYSIS_APPROVED_MILESTONE_REQUIRED");
      // Every identity that has an approved milestone is offered; choosing between them is the Skill's
      // job, because an app-side pick would be exactly the silent guess this design removed.
      const identities = new Set(milestones.map((m) => m.identityId));
      const packs = defaultIdentityPacks().filter((p) => p.kind === "identity" && identities.has(p.id));
      if (packs.length !== identities.size) throw new Error("ANALYSIS_IDENTITY_CONTEXT_REQUIRED");
      const context = validateAnalysisContext({
        version: "crossline.analysis.v1", capture: { title: capture.title, context: capture.context },
        approvedMilestones: milestones.map((m) => ({ id: m.id, identityId: m.identityId, projectId: m.projectId!, title: m.title, version: m.version })),
        // The note the person attached to the capture, handed over as what it is. It was hardcoded
        // empty, so the Skill could never see any material the user supplied and correctly refused
        // every capture that depended on some. Passing it does not assert it IS the material: a note
        // that merely says where the notes live is still not the notes, and the Skill judges that.
        // Names only, never file bytes — the Skill contract requires every quote to be verbatim from
        // supplied text, and attachment content is not decoded or sent to the model at all. This just
        // lets it know material was actually supplied somewhere, instead of always reading as none.
        availableInputs: [
          ...(capture.context.trim() ? [{ id: "capture-context", text: capture.context.trim() }] : []),
          ...(store.listCaptureAttachments(workspaceId, id).length
            ? [{ id: "capture-attachments", text: `用户上传了 ${store.listCaptureAttachments(workspaceId, id).length} 份附件，文件名：${
                store.listCaptureAttachments(workspaceId, id).map((item) => item.fileName).join("、")}` }]
            : [])
        ],
        identityPacks: packs.map((p) => ({ id: p.id, version: 1, summary: `${p.label}; workflows: ${p.workflowTemplates.join(", ")}; evidence: ${p.evidencePolicy}` })),
        historicalStats: buildHistoricalStats(store, workspaceId, [...identities]),
        policy: { tools: [], externalSideEffects: false, humanApprovalRequired: true }
      });
      store.updateAnalysisAudit(workspaceId, id, { contextVersion: context.version });
      const result = await runCodexAnalysis(client, context, { skillName: "crossline:crossline-automation-stripper", cwd, ...(signal ? { signal } : {}),
        onAudit: (audit) => store.updateAnalysisAudit(workspaceId, id, audit) });
      if (!result.ok) {
        store.transitionWorkOrder(workspaceId, id, { type: "blocked", reason: result.blocker.code }, `analysis:${id}:${attempt}:finish`, { audit: { ...result.audit, blocker: result.blocker } });
      } else {
        store.transitionWorkOrder(workspaceId, id, { type: "analysis.accepted", approvalId: "schema-validation-only" }, `analysis:${id}:${attempt}:finish`, {
          proposal: result.proposal, context, audit: { ...result.audit, contextVersion: context.version }
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = /^ANALYSIS_[A-Z_]+$/.test(message) ? message : "ANALYSIS_RUNTIME_FAILED";
      store.transitionWorkOrder(workspaceId, id, { type: "blocked", reason: code }, `analysis:${id}:${attempt}:finish`, {
        audit: { blocker: { code, message: "分析被阻塞；原始 Capture 已保留，可继续人工处理。" } }
      });
    }
    return outcome(id);
  };
}
