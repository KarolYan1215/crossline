import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { ensureSeeded } from "./crossline";
import { TEST_CTX } from "./test-support";
import { permissionCandidates, permissionHeartbeat, permissionModeEnabled,
  rejectPermissionCandidate, revokeInsight, setPermissionMode } from "./permission-mode";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });
const ownerId = TEST_CTX.principalId;
function setup() {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  ensureSeeded(TEST_CTX);
  const add = (id: string, intent: string, riskTier: "routine" | "high_risk") => store.saveWorkOrder({
    id, ownerId, workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "research-default",
    milestoneId: "research-starter", intent, state: "awaiting_plan_approval", riskTier,
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40,
      source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { localDraft: true, family: "preparation" }
  });
  return { store, add };
}

test("five foreground minutes approve one version; background and offline gaps do not advance it", () => {
  const { store, add } = setup();
  add("local", "整理本地笔记", "routine");
  expect(permissionModeEnabled(TEST_CTX)).toBe(false);
  const key = permissionCandidates(TEST_CTX).find((item) => item.id === "local")!.key;
  permissionHeartbeat(TEST_CTX, [key], true, 0);
  expect(store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.id === "local")?.state).toBe("awaiting_plan_approval");
  setPermissionMode(TEST_CTX, true);
  permissionHeartbeat(TEST_CTX, [key], true, 0);
  for (let t = 10_000; t <= 100_000; t += 10_000) permissionHeartbeat(TEST_CTX, [key], true, t);
  permissionHeartbeat(TEST_CTX, [key], false, 101_000);
  permissionHeartbeat(TEST_CTX, [key], true, 250_000);
  expect(permissionCandidates(TEST_CTX).find((item) => item.id === "local")?.elapsedMs).toBe(100_000);
  for (let t = 260_000; t <= 440_000; t += 10_000) permissionHeartbeat(TEST_CTX, [key], true, t);
  expect(store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.id === "local")?.state).toBe("awaiting_plan_approval");
  permissionHeartbeat(TEST_CTX, [key], true, 450_000);
  expect(store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.id === "local")?.state).toBe("approved");
  expect(store.listEvents(TEST_CTX.workspaceId, { type: "permission.auto_approved" })).toHaveLength(1);
});

test("editing a proposal starts a new foreground approval window", () => {
  const { store, add } = setup();
  add("editable", "整理本地笔记", "routine");
  setPermissionMode(TEST_CTX, true);
  const original = permissionCandidates(TEST_CTX).find((item) => item.id === "editable")!;
  for (let t = 0; t <= 290_000; t += 10_000) permissionHeartbeat(TEST_CTX, [original.key], true, t);
  const order = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.id === "editable")!;
  store.saveWorkOrder({ ...order, intent: "整理本地实验笔记" });
  expect(permissionCandidates(TEST_CTX).find((item) => item.id === "editable")!.key).not.toBe(original.key);
  permissionHeartbeat(TEST_CTX, [original.key], true, 300_000);
  expect(store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.id === "editable")?.state)
    .toBe("awaiting_plan_approval");
});

test("the store refuses an auto approval after its proposal snapshot changes", () => {
  const { store, add } = setup();
  add("racy", "整理本地笔记", "routine");
  const proposal = store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.id === "racy")!;
  store.saveWorkOrder({ ...proposal, payload: { localDraft: true, family: "preparation", revised: true } });
  expect(() => store.transitionWorkOrder(TEST_CTX.workspaceId, "racy",
    { type: "plan.approved", approvalId: ownerId }, "auto:racy",
    { expectedWorkOrder: proposal })).toThrow("PROPOSAL_VERSION_CHANGED");
  expect(store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.id === "racy")?.state)
    .toBe("awaiting_plan_approval");
});

test("the store refuses a plan change auto approval after its version changes", () => {
  const { store } = setup();
  store.savePlanChange({ id: "changing", ownerId, workspaceId: TEST_CTX.workspaceId,
    planVersionId: "personal-plan-v1", kind: "add", triggerEventId: "trigger",
    explanation: "新增建议块", status: "pending" });
  const plan = store.listPlanVersions(TEST_CTX.workspaceId)[0]!;
  const change = store.listPlanChanges(TEST_CTX.workspaceId, plan.id).find((item) => item.id === "changing")!;
  store.savePlanVersion({ ...plan, payload: { changed: true } });
  expect(() => store.resolvePlanChange(TEST_CTX.workspaceId, ownerId, change.id, "approved", "auto:changing",
    { plan, change })).toThrow("PROPOSAL_VERSION_CHANGED");
  expect(store.listPlanChanges(TEST_CTX.workspaceId, plan.id).find((item) => item.id === change.id)?.status).toBe("pending");
});

test("rejection blocks the candidate and high risk never auto approves", () => {
  const { store, add } = setup();
  add("reject", "整理本地记录", "routine");
  add("external", "发送邮件给外部", "routine");
  add("property", "整理财产交易", "high_risk");
  setPermissionMode(TEST_CTX, true);
  const candidates = permissionCandidates(TEST_CTX);
  expect(candidates.find((item) => item.id === "external")?.eligible).toBe(false);
  expect(candidates.find((item) => item.id === "property")?.eligible).toBe(false);
  expect(rejectPermissionCandidate(TEST_CTX, candidates.find((item) => item.id === "reject")!.key)).toEqual({ ok: true });
  for (let t = 0; t <= 400_000; t += 10_000)
    permissionHeartbeat(TEST_CTX, candidates.map((item) => item.key), true, t);
  expect(store.listWorkOrders(TEST_CTX.workspaceId).filter((item) => ["external", "property"].includes(item.id))
    .every((item) => item.state === "awaiting_plan_approval")).toBe(true);
  expect(store.listWorkOrders(TEST_CTX.workspaceId).find((item) => item.id === "reject")?.state).toBe("blocked");
  expect(store.listEvents(TEST_CTX.workspaceId, { type: "permission.rejected" })).toHaveLength(1);
});

test("non-conflict plan change can auto apply, while a reality conflict stays pending", () => {
  const { store } = setup();
  for (const [id, kind] of [["simple", "add"], ["reality", "conflict"]] as const)
    store.savePlanChange({ id, ownerId, workspaceId: TEST_CTX.workspaceId, planVersionId: "personal-plan-v1",
      kind, triggerEventId: "trigger", explanation: id, status: "pending" });
  setPermissionMode(TEST_CTX, true);
  const candidates = permissionCandidates(TEST_CTX);
  expect(candidates.find((item) => item.id === "reality")?.eligible).toBe(false);
  for (let t = 0; t <= 300_000; t += 10_000)
    permissionHeartbeat(TEST_CTX, candidates.map((item) => item.key), true, t);
  expect(store.listPlanChanges(TEST_CTX.workspaceId, "personal-plan-v1").find((item) => item.id === "simple")?.status).toBe("approved");
  expect(store.listPlanChanges(TEST_CTX.workspaceId, "personal-plan-v1").find((item) => item.id === "reality")?.status).toBe("pending");
});

test("sourced insight becomes usable after foreground approval and can be revoked", () => {
  const { store } = setup();
  const finding = store.appendEvent({ ownerId, workspaceId: TEST_CTX.workspaceId,
    idempotencyKey: "finding-1", type: "flywheel.finding", entityId: "research-starter",
    payload: { milestoneId: "research-starter", summary: "可复用的实验记录模板",
      sourceUrl: "https://example.org/source", staleWhen: "方法变更" } });
  const candidate = permissionCandidates(TEST_CTX).find((item) => item.kind === "insight")!;
  expect(candidate.eligible).toBe(true);
  setPermissionMode(TEST_CTX, true);
  for (let t = 0; t <= 300_000; t += 10_000) permissionHeartbeat(TEST_CTX, [candidate.key], true, t);
  expect(store.listEvents(TEST_CTX.workspaceId, { type: "insight.approved", entityId: finding.eventId })).toHaveLength(1);
  expect(permissionCandidates(TEST_CTX).some((item) => item.key === candidate.key)).toBe(false);
  expect(revokeInsight(TEST_CTX, finding.eventId)).toEqual({ ok: true });
  expect(revokeInsight(TEST_CTX, finding.eventId)).toEqual({ ok: false, code: "INSIGHT_NOT_ACTIVE" });
});
