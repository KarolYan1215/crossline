/**
 * Gate 3–4 evidence (design §12): drive one WorkOrder through the whole closed loop against the live
 * Codex runtime — material preparation, execution with a real interruption, evidence submission, and
 * the milestone gate's auto-acceptance.
 *
 *   pnpm exec tsx scripts/gate-loop-check.ts
 *
 * It uses a throwaway database under the OS temp dir. The milestone it creates carries real success
 * criteria, because a milestone with none is refused by the gate — correctly, and that refusal is
 * itself checked here before the criteria are added.
 */
// Relative imports, not @crossline/*: the repo root is not a workspace package, so it has no such deps.
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SuccessCriterion } from "../packages/core/src/index";
import { startCodexSupervisor } from "../packages/codex/src/index";
import { CrosslineStore } from "../packages/db/src/index";
import { createManualbookBuilder } from "../apps/worker/src/manualbook";
import { createMilestoneGate } from "../apps/worker/src/milestone-gate-runner";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-gate-loop-"));
const projectRoot = mkdtempSync(path.join(tmpdir(), "crossline-gate-project-"));
const WORKSPACE = "personal-crossline";
const OWNER = "local-owner";
const ORDER_ID = "gate-loop-order";

const criteria: SuccessCriterion[] = [
  { id: "summary-exists", statement: "存在一份组会用的方法学摘要文件。", required: true,
    measure: { kind: "artifact", mustExist: "methodology-summary" } },
  { id: "key-points", statement: "摘要中至少列出 2 个要点。", required: true,
    measure: { kind: "count", unit: "key_points", atLeast: 2 } }
];

const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const failures: string[] = [];
const check = (label: string, condition: boolean, detail?: unknown) => {
  console.info(JSON.stringify({ step: label, ok: condition, ...(detail === undefined ? {} : { detail }) }));
  if (!condition) failures.push(label);
};

store.saveMilestone({ id: "gate-loop-milestone", ownerId: OWNER, workspaceId: WORKSPACE,
  identityId: "research", projectId: "gate-loop-project", title: "把方法学讲清楚", version: 1, status: "approved" });
store.saveWorkOrder({
  id: ORDER_ID, ownerId: OWNER, workspaceId: WORKSPACE, identityId: "research",
  projectId: "gate-loop-project", milestoneId: "gate-loop-milestone",
  intent: "为组会准备一页方法学摘要", state: "approved", riskTier: "milestone",
  estimate: { p25Minutes: 20, p50Minutes: 35, p85Minutes: 60, source: "llm_prior", observationCount: 0, confidence: "low" },
  payload: {
    materialContract: [{ id: "c0", description: "一页方法学摘要草稿，列出方法步骤与至少两个要点", required: true }],
    availableInputs: [{ id: "i0", text: "方法：先做基线对照，再逐项消融；每次只改一个变量。" }],
    evidenceContract: [{ kind: "file", description: "方法学摘要文件" }],
    humanCore: [{ id: "h0", intent: "确认摘要里的判断是否成立", energy: "high", interruptible: false }]
  }
});

const supervisor = await startCodexSupervisor({
  port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3399),
  plugin: {
    name: "crossline",
    marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"),
    cwd: repoRoot,
    requiredSkills: ["crossline:crossline-manualbook-designer", "crossline:crossline-material-researcher", "crossline:crossline-material-writer", "crossline:crossline-milestone-gate"]
  }
});

try {
  // ---- Gate 3: a non-empty material contract really reaches `preparing` and produces real materials.
  store.transitionWorkOrder(WORKSPACE, ORDER_ID, { type: "automation.started" }, `materials-preparing:${ORDER_ID}`);
  check("enters_preparing", store.listWorkOrders(WORKSPACE)[0]?.state === "preparing");

  const materialsDir = path.join(projectRoot, "materials");
  const prepare = createManualbookBuilder(store, WORKSPACE, materialsDir, repoRoot, () => supervisor.client,
    { readCost: () => supervisor.readCostSignal() });
  const prepared = await prepare(ORDER_ID);
  check("materials_prepared", prepared.state === "ready", prepared);
  const materials = store.listMaterials(WORKSPACE, ORDER_ID);
  check("material_reference_stored", materials.length > 0, materials.map((item) => item.uri));
  const written = readdirSync(path.join(materialsDir, ORDER_ID), { recursive: true }) as string[];
  check("files_on_disk", written.length > 0, written);
  check("ready_for_human", store.listWorkOrders(WORKSPACE)[0]?.state === "ready_for_human");

  // ---- Execution, including a real interruption with a stated reason.
  store.transitionWorkOrder(WORKSPACE, ORDER_ID, { type: "human.started" }, `execution:${ORDER_ID}:started`, { durationObserved: true });
  store.pauseExecution(WORKSPACE, ORDER_ID, "被组会打断");
  store.resumeExecution(WORKSPACE, ORDER_ID);
  const execution = store.listExecutions(WORKSPACE).find((item) => item.workOrderId === ORDER_ID);
  check("interruption_recorded", (execution?.interruptions ?? []).some((item) => item.reason === "被组会打断"), execution?.interruptions);

  store.transitionWorkOrder(WORKSPACE, ORDER_ID, { type: "human.completed" }, `execution:${ORDER_ID}:completed`, {
    evidence: [{
      kind: "file",
      uri: materials[0]?.uri ?? "file:///missing",
      description: "方法学摘要：要点一是先做基线对照，要点二是每次只改一个变量。共 2 个要点。"
    }]
  });
  check("evidence_review", store.listWorkOrders(WORKSPACE)[0]?.state === "evidence_review");

  // ---- Gate 4: the gate refuses a milestone with no criteria before it judges anything.
  const judge = createMilestoneGate(store, WORKSPACE, repoRoot, () => supervisor.client);
  const withoutCriteria = await judge(ORDER_ID);
  check("refuses_milestone_without_criteria",
    withoutCriteria.state === "blocked" && withoutCriteria.code === "MILESTONE_NEEDS_CRITERIA", withoutCriteria);

  store.saveMilestone({ id: "gate-loop-milestone", ownerId: OWNER, workspaceId: WORKSPACE,
    identityId: "research", projectId: "gate-loop-project", title: "把方法学讲清楚", version: 1,
    status: "approved", successCriteria: criteria });

  const verdict = await judge(ORDER_ID);
  check("gate_ran", verdict.state !== "blocked", verdict);
  const finalState = store.listWorkOrders(WORKSPACE)[0]?.state;
  const autoAccepted = store.listEvents(WORKSPACE).some((event) => event.type === "milestone_gate.auto_accepted");
  console.info(JSON.stringify({ step: "gate_outcome", verdict, finalState, autoAccepted }, null, 1));
  // A `pass` must auto-accept with no human step; anything else must NOT reach `accepted`.
  if (verdict.state === "accepted") {
    check("pass_auto_accepts", finalState === "accepted" && autoAccepted);
  } else {
    check("non_pass_is_held", finalState !== "accepted" && !autoAccepted);
  }
} finally {
  await supervisor.stop();
  store.close();
}

console.info(JSON.stringify({ status: failures.length ? "gates_failed" : "gates_passed", failures, dataDir, projectRoot }));
process.exitCode = failures.length ? 1 : 0;
