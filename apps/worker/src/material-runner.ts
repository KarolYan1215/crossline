import {
  MATERIAL_OUTPUT_SCHEMA, budgetPolicy, validateMaterialPreparation,
  type CostSignal, type MaterialContext, type MaterialPreparation
} from "@crossline/core";
import { runCodexSkill, type CodexRpcBoundary } from "@crossline/codex";
import type { CrosslineStore } from "@crossline/db";
import { persistPreparedMaterials } from "./materials";

const OWNER_ID = "local-owner";
export const MATERIAL_SKILL = "crossline:crossline-material-preparer";

const INSTRUCTIONS = "Prepare the local materials described by the supplied material contract. Return "
  + "only the requested JSON. Every artifact needs a bare relative path inside the work order's own "
  + "materials folder — for example `method-summary.md`. Never include `.crossline-materials/` or the "
  + "work order id in the path; the app adds those. Content must be UTF-8 text in one of the allowed "
  + "text media types, and sourceRefs must name either a URL you actually read or an id supplied in "
  + "this context. Each materialContract item carries `required`: a missing REQUIRED item is a blocker, "
  + "but a missing OPTIONAL one is not — prepare what the supplied inputs do support and record the gap "
  + "in unresolvedQuestions rather than refusing the whole job. Do not perform the human decision, do not send "
  + "or publish anything, and do not claim the work order is complete. If you cannot satisfy the "
  + "contract, return a blocker explaining why instead of guessing — the person can still prepare the "
  + "materials themselves.";

type MaterialRunOutcome =
  | { state: "ready"; workOrderId: string; artifacts: number }
  | { state: "blocked"; workOrderId: string; code: string; message: string };

/** The text the person attached when they captured this, still readable after promotion. */
function captureInputs(store: CrosslineStore, workspaceId: string, workOrderId: string): Array<{ id: string; text: string }> {
  const capture = store.listCaptures(workspaceId).find((item) => item.id === workOrderId);
  if (!capture) return [];
  return [
    { id: "capture-context", text: capture.context.trim() },
    { id: "capture-title", text: capture.title.trim() }
  ].filter((input) => input.text);
}

export function buildMaterialContext(store: CrosslineStore, workspaceId: string, workOrderId: string): MaterialContext | undefined {
  const order = store.listWorkOrders(workspaceId).find((item) => item.id === workOrderId);
  if (!order) return undefined;
  const payload = order.payload as {
    materialContract?: Array<{ id?: string; description?: string; kind?: string; required?: boolean }>;
    availableInputs?: Array<{ id?: string; text?: string }>;
  };
  return {
    version: "crossline.materials.v1",
    workOrder: {
      id: order.id, intent: order.intent, identityId: order.identityId,
      milestoneId: order.milestoneId ?? null
    },
    // Contract items are given stable ids so the Skill can cite one as a sourceRef and the citation
    // means something; an item with no id could only ever be cited by invention.
    materialContract: (payload.materialContract ?? []).map((item, index) => ({
      id: item.id ?? `${order.id}-contract-${index}`,
      description: item.description ?? item.kind ?? "",
      // Absent means required: a proposal written before the flag existed must not silently become
      // optional. The analysis marks an item optional only when it says so.
      required: item.required !== false
    })),
    // The material the person actually supplied lives on the capture row, not on the proposal the Skill
    // returned — a promoted capture keeps its id, so it is still readable here. Without this the
    // preparer saw an empty `availableInputs` and correctly refused every work order whose materials
    // depended on something the user had already pasted in.
    availableInputs: [
      ...(payload.availableInputs ?? [])
        .map((input, index) => ({ id: input.id ?? `${order.id}-input-${index}`, text: input.text ?? "" })),
      ...captureInputs(store, workspaceId, order.id)
    ].filter((input) => input.text),
    budget: { mode: "normal" }
  };
}

/**
 * Runs the material preparer for one WorkOrder that is sitting in `preparing`, and persists whatever
 * it produced through the single audited write path.
 *
 * A failure leaves the WorkOrder in `preparing` with a typed blocker rather than advancing it: the
 * human self-preparation path stays open, which is the whole reason preparation is a state you pass
 * through rather than a gate that can trap an item.
 */
export function createMaterialPreparer(store: CrosslineStore, workspaceId: string, projectRoot: string,
  getClient: () => CodexRpcBoundary | undefined, readCost: () => Promise<CostSignal>) {
  return async function prepare(workOrderId: string): Promise<MaterialRunOutcome> {
    const client = getClient();
    if (!client) return { state: "blocked", workOrderId, code: "CODEX_SUPERVISOR_UNAVAILABLE", message: "Codex 运行时不可用；你仍可人工自备材料。" };

    const context = buildMaterialContext(store, workspaceId, workOrderId);
    if (!context) return { state: "blocked", workOrderId, code: "WORK_ORDER_NOT_FOUND", message: "找不到该作业。" };
    if (!context.materialContract.length) {
      return { state: "blocked", workOrderId, code: "MATERIALS_NOT_REQUIRED", message: "该作业没有材料契约。" };
    }

    // Preparation is discretionary spend. Under manual_core_only the honest answer is to leave it to
    // the person rather than quietly spend the last of the window on a convenience.
    const signal = await readCost();
    const mode = signal.available
      ? budgetPolicy(Math.max(signal.short?.usedPercent ?? 0, signal.long?.usedPercent ?? 0)).mode
      : "manual_core_only";
    if (mode === "manual_core_only") {
      return { state: "blocked", workOrderId,
        code: signal.available ? "MATERIAL_BUDGET_EXHAUSTED" : "COST_SIGNAL_UNAVAILABLE",
        message: signal.available ? "预算已用尽；材料请人工自备。" : "读不到用量信号；材料请人工自备。" };
    }
    context.budget.mode = mode;

    const result = await runCodexSkill<MaterialPreparation>(client, context, {
      skillName: MATERIAL_SKILL,
      cwd: projectRoot,
      developerInstructions: INSTRUCTIONS,
      outputSchema: MATERIAL_OUTPUT_SCHEMA,
      prepareInput: () => context,
      validateOutput: (output) => validateMaterialPreparation(output, context),
      onAudit: () => {},
      timeoutMs: 10 * 60_000
    });
    if (!result.ok) {
      store.appendEvent({
        ownerId: OWNER_ID, workspaceId,
        idempotencyKey: `materials:blocked:${workOrderId}:${result.blocker.code}`,
        type: "materials.blocked", entityId: workOrderId, payload: result.blocker
      });
      return { state: "blocked", workOrderId, code: result.blocker.code, message: result.blocker.message };
    }

    // `persistPreparedMaterials` re-checks every path against the resolved root before writing. The
    // schema check above is not trusted to be the only guard: this is the write, so it verifies again.
    const persisted = persistPreparedMaterials(store, {
      workspaceId, ownerId: OWNER_ID, workOrderId, projectRoot,
      files: result.output.artifacts
    });
    if (!persisted.ok) {
      return { state: "blocked", workOrderId, code: persisted.blocker.code, message: persisted.blocker.message };
    }
    if (result.output.unresolvedQuestions.length) {
      // Questions the Skill could not answer are the person's to resolve, so they are recorded rather
      // than dropped — but they never block the materials that did get prepared.
      store.appendEvent({
        ownerId: OWNER_ID, workspaceId,
        idempotencyKey: `materials:questions:${workOrderId}`,
        type: "materials.questions", entityId: workOrderId,
        payload: { questions: result.output.unresolvedQuestions }
      });
    }
    return { state: "ready", workOrderId, artifacts: persisted.artifacts.length };
  };
}

/** Every WorkOrder currently waiting on material preparation that has not already had materials written. */
export function pendingMaterialWorkOrders(store: CrosslineStore, workspaceId: string): string[] {
  // A preparation that already failed is not retried on a timer: it would re-spend quota every tick with
  // no new information, and the human self-preparation path is open the whole time. Retrying is a
  // deliberate act — so the LAST word wins: a retry the person asked for re-opens the order, and a
  // failure after that closes it again. Without the retry side, an order blocked by a bug that has
  // since been fixed could never be tried again.
  const decidedAt = new Map<string, "blocked" | "retry">();
  for (const event of store.listEvents()) {
    if (event.workspaceId !== workspaceId) continue;
    if (event.type === "materials.blocked") decidedAt.set(event.entityId, "blocked");
    else if (event.type === "materials.retry_requested") decidedAt.set(event.entityId, "retry");
  }
  return store.listWorkOrders(workspaceId)
    .filter((order) => order.state === "preparing" && decidedAt.get(order.id) !== "blocked")
    .filter((order) => store.listMaterials(workspaceId, order.id).length === 0)
    .map((order) => order.id);
}
