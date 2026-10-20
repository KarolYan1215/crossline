import { personProfileFor } from "./planning-profile";
import { autoApproveEligible } from "./auto-approval";
import { ownerOf } from "./owner";
import type { AnalysisDate, AnalysisWaitingOn } from "@crossline/core";
import { runCodexAnalysis, type CodexRpcBoundary } from "@crossline/codex";
import { ANALYSIS_CONTEXT_VERSION, validateAnalysisContext, type AnalysisContext } from "@crossline/core";
import { CrosslineStore, type StoredCapture } from "@crossline/db";
import { identityLines } from "./lines";
import { existingTasksFor, foldNewTask } from "./duplicate-guard";

export type AnalysisOutcome = { id: string; state: string; attempt: number; audit: StoredCapture["audit"] };

/**
 * The outside view, as raw examples: the most recently finished tasks with what the analysis estimated for them
 * and what they really took. No ratio and no median — a correction factor shown to the model anchors its
 * estimate and is then applied a second time by the calibration that runs on its output.
 */
export function buildReferenceClass(store: CrosslineStore, workspaceId: string, limit = 5): NonNullable<AnalysisContext["referenceClass"]> {
  const orders = new Map(store.listWorkOrders(workspaceId).map((order) => [order.id, order]));
  return store.listAllDurationObservations(workspaceId)
    .filter((row) => !row.interruptionDominant && orders.get(row.workOrderId)?.estimate.source === "llm_prior")
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
    .slice(0, limit)
    .map((row) => {
      const order = orders.get(row.workOrderId)!;
      return { identityId: row.identityId, family: row.family as "preparation" | "review" | "deep_work",
        title: order.intent.slice(0, 40), llmP50Minutes: order.estimate.p50Minutes, actualMinutes: row.observedMinutes };
    });
}

/** The person's local date: what 「周末前」「10月8号左右」 is read against. */
export function localToday(store: CrosslineStore, workspaceId: string, now = new Date()): string {
  let zone = process.env.CROSSLINE_TIME_ZONE?.trim() || "America/Chicago";
  try { zone = (JSON.parse(store.getSetting(workspaceId, "schedule.preferences") ?? "null") as { timeZone?: string } | null)?.timeZone || zone; } catch { /* default */ }
  return new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// `workspaceId` is the real caller's, fixed at creation — one analyzer per real workspace, the same
// pattern `createMaterialPreparer`/`createMilestoneGate` already use. This used to be a hardcoded
// module-level single-user workspace constant plus an owner-constant filter on every read, so a
// real account's own captures and milestones were invisible to it: `getCapture` threw
// `CAPTURE_NOT_FOUND` and the milestones filter threw `ANALYSIS_APPROVED_MILESTONE_REQUIRED` even with
// approved milestones on the books, because workspace-scoping already makes the ownerId check redundant
// and wrong for any account that is not that one literal owner.
/**
 * The files the person already gave the system (syllabi, schedules, notes from the first interview), as inputs the analysis may rely
 * on. Without them a capture about 「ECE 548 前几章」 asked the person for course materials the system was already holding.
 * Names and a short opening only — the contract says model input is supplied text, and a whole syllabus on every capture is waste.
 */
export function uploadedMaterialInputs(store: CrosslineStore, workspaceId: string, limit = 8): Array<{ id: string; text: string }> {
  return store.listSourceDocuments(workspaceId)
    .filter((doc) => doc.extractionStatus === "done" && doc.extractedText.trim())
    .slice(0, limit)
    .map((doc) => ({
      id: `uploaded-${doc.id}`,
      text: `用户此前已交给系统的资料《${doc.fileName}》（已读取，共 ${doc.extractedText.length} 字，不必再向用户要）。开头：${doc.extractedText.trim().replace(/\s+/g, " ").slice(0, 300)}`
    }));
}

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
      // Every line is offered, with or without an approved milestone: choosing between them is the Skill's job, and work that
      // serves no milestone yet is filed under its line unbound (an empty milestoneId), not held until a milestone is approved —
      // that hold made a new account's first day a dead end. Approved milestones are offered for binding when they exist.
      const packs = identityLines(store, workspaceId);
      if (!packs.length) throw new Error("ANALYSIS_IDENTITY_CONTEXT_REQUIRED");
      const lines = new Set(packs.map((p) => p.id));
      const milestones = store.listMilestones(workspaceId).filter((m) => m.status === "approved" && m.projectId && lines.has(m.identityId));
      const deadlines = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
      const context = validateAnalysisContext({
        version: ANALYSIS_CONTEXT_VERSION, today: localToday(store, workspaceId), capture: { title: capture.title, context: capture.context },
        approvedMilestones: milestones.map((m) => ({ id: m.id, identityId: m.identityId, projectId: m.projectId!, title: m.title, version: m.version,
          hasSuccessCriteria: m.verifiability !== "unstated", deadline: deadlines.get(m.id) ?? "" })),
        // The note the person attached to the capture, handed over as what it is. It was hardcoded
        // empty, so the Skill could never see any material the user supplied and correctly refused
        // every capture that depended on some. Passing it does not assert it IS the material: a note
        // that merely says where the notes live is still not the notes, and the Skill judges that.
        // Names only, never file bytes — the Skill contract requires every quote to be verbatim from
        // supplied text, and attachment content is not decoded or sent to the model at all. This just
        // lets it know material was actually supplied somewhere, instead of always reading as none.
        availableInputs: [
          ...uploadedMaterialInputs(store, workspaceId),
          ...(capture.context.trim() ? [{ id: "capture-context", text: capture.context.trim() }] : []),
          ...(store.listCaptureAttachments(workspaceId, id).length
            ? [{ id: "capture-attachments", text: `用户上传了 ${store.listCaptureAttachments(workspaceId, id).length} 份附件，文件名：${
                store.listCaptureAttachments(workspaceId, id).map((item) => item.fileName).join("、")}` }]
            : [])
        ],
        identityPacks: packs.map((p) => ({ id: p.id, version: 1, summary: `${p.label}; workflows: ${p.workflowTemplates.join(", ")}; evidence: ${p.evidencePolicy}` })),
        referenceClass: buildReferenceClass(store, workspaceId),
        relations: store.listMilestoneRelations(workspaceId).filter((relation) => relation.status === "approved").slice(0, 40)
          .map((relation) => ({ fromMilestoneId: relation.fromMilestoneId, toMilestoneId: relation.toMilestoneId, kind: relation.kind,
            explanation: relation.explanation ?? "" })),
        // What the person has corrected or shown about how they work, across every line (the capture's line is not known yet).
        personalPreferences: store.preferenceLines(workspaceId, packs.map((pack) => pack.id), 20),
        // The interview's conclusions for planning (how the person works, drains, direction): the estimate and the split are this person's.
        personProfile: personProfileFor(store, workspaceId),
        // The open tasks already on the board, so the same work is not written twice and an addition says what it adds to.
        existingTasks: existingTasksFor(store, workspaceId),
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
        recordWaitingAndDates(store, workspaceId, id);
        // Work the board already has is folded into that task instead of standing beside it (after the dates, so the earlier due day carries).
        if (!foldNewTask(store, workspaceId, id, result.proposal.extendsTaskId ?? "")) autoApproveEligible(store, workspaceId, [id]);
        // A quality problem the repairs did not fix was corrected in the smallest way and kept; the reviewer looks at it next.
        if (result.audit.warnings?.length) store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId,
          idempotencyKey: `validation.warned:analysis:${id}:${attempt}`, type: "validation.warned", entityId: `analysis:${id}`,
          payload: { subject: "analysis", version: attempt, warnings: result.audit.warnings, revised: false } });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const code = /^ANALYSIS_[A-Z_]+$/.test(message) ? message : "ANALYSIS_RUNTIME_FAILED";
      store.transitionWorkOrder(workspaceId, id, { type: "blocked", reason: code }, `analysis:${id}:${attempt}:finish`, {
        audit: { blocker: { code, message: BLOCKER_ADVICE[code] ?? "分析被阻塞；原始 Capture 已保留，可继续人工处理。" } }
      });
    }
    return outcome(id);
  };
}

/**
 * What the person is told, in words that say what to do. A bare code and 「分析被阻塞」 left someone holding a blocked task they had
 * captured on purpose with no idea that approving a milestone was the whole fix.
 */
const BLOCKER_ADVICE: Record<string, string> = {
  // No longer raised; kept so a capture an older version blocked this way still reads sensibly until the tick re-picks it.
  ANALYSIS_APPROVED_MILESTONE_REQUIRED: "还没有已批准的里程碑。系统会自动重新分析这条。",
  ANALYSIS_IDENTITY_CONTEXT_REQUIRED: "还没有主线：先完成访谈，或在「主线」新增一条。"
};

/**
 * Captures the background tick should analyse on its own: never analysed (`attempt` 0, still `captured`). An approved milestone
 * is not required (an unbound analysis files the work under its line), so a new account's captures are analysed on day one.
 *
 * A capture that was analysed and blocked is deliberately NOT here: that one waits for the person (add context, press
 * re-analyse). Retrying it on a timer would spend quota to fail the same way every fifteen minutes.
 */
export function capturesAwaitingAutoAnalysis(store: CrosslineStore, workspaceId: string, limit = 3): string[] {
  if (!identityLines(store, workspaceId).length) return [];
  return store.listCaptures(workspaceId)
    // Also a capture an older version blocked for want of an approved milestone: that requirement is gone, so it is re-picked.
    .filter((capture) => (capture.state === "captured" && capture.attempt === 0)
      || (capture.state === "blocked" && capture.audit.blocker?.code === "ANALYSIS_APPROVED_MILESTONE_REQUIRED"))
    .slice(0, limit).map((capture) => capture.id);
}

/**
 * What the analysis read off the capture's own dates, turned into things the scheduler and the person act on:
 * a release date (`notBefore`) the work is not placed before, a due date, and — when the work waits for
 * someone — a waiting item that asks the person on the expected day whether it came. Only verified dates
 * reach here (`validateAnalysisProposal` drops a date its quote does not name).
 */
export function recordWaitingAndDates(store: CrosslineStore, workspaceId: string, workOrderId: string): void {
  const order = store.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
  if (!order) return;
  const payload = order.payload as { dates?: AnalysisDate[]; waitingOn?: AnalysisWaitingOn };
  const release = (payload.dates ?? []).filter((item) => item.kind === "release").map((item) => item.date).sort().at(-1);
  const due = (payload.dates ?? []).filter((item) => item.kind === "due").map((item) => item.date).sort()[0];
  const waiting = payload.waitingOn;
  const waitingDate = waiting && (waiting.who.trim() || waiting.what.trim()) && waiting.expectedDate ? waiting.expectedDate : undefined;
  const notBefore = [release, waitingDate].filter((date): date is string => Boolean(date)).sort().at(-1);
  if (notBefore || due) store.saveWorkOrder({ ...order, payload: { ...(order.payload as object), ...(notBefore ? { notBefore } : {}), ...(due ? { dueDate: due } : {}) } });
  if (waitingDate && waiting) {
    store.saveWaitingItem({ id: `wait-${workOrderId}`, ownerId: ownerOf(store, workspaceId), workspaceId,
      title: waiting.what.trim() || order.intent, who: waiting.who.trim(), expectedAt: waitingDate,
      approximate: (payload.dates ?? []).some((item) => item.approximate && item.date === waitingDate) || /左右|大概|大约|前后/.test(waiting.quote),
      followUpAt: waitingDate, state: "open", blocks: [workOrderId], source: "analysis" });
  }
}
