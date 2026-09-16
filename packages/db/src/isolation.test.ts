import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "./index";

/**
 * Two workspaces in one database, proving the scoping is real.
 *
 * Nothing had ever tested this: every other suite uses a single workspace, and a repo-wide search for
 * a second one came back empty. That mattered because `listEvents()` took no workspace at all and
 * several call sites filtered only by event type — which reads fine until a second workspace exists.
 *
 * Crossline is one database per person, so a second workspace is not a feature anyone is asking for
 * today. The discipline is what keeps that a deployment choice rather than a rewrite.
 */
let store: CrosslineStore;
const A = "workspace-a";
const B = "workspace-b";

const seed = (workspaceId: string, suffix: string) => {
  store.saveMilestone({ id: `m-${suffix}`, ownerId: `owner-${suffix}`, workspaceId, identityId: "research",
    projectId: "p", title: `里程碑 ${suffix}`, version: 1, status: "approved",
    successCriteria: [{ id: `c-${suffix}`, statement: "一条", required: true, measure: { kind: "count", unit: "份", atLeast: 1 } }] });
  store.saveWorkOrder({ id: `w-${suffix}`, ownerId: `owner-${suffix}`, workspaceId, identityId: "research",
    projectId: "p", milestoneId: `m-${suffix}`, intent: `作业 ${suffix}`, state: "ready_for_human", riskTier: "milestone",
    payload: {}, estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" } });
  store.capture({ id: `cap-${suffix}`, ownerId: `owner-${suffix}`, workspaceId, title: `捕获 ${suffix}`, context: "" }, `cap:${suffix}`);
  store.saveMaterial({ id: `mat-${suffix}`, ownerId: `owner-${suffix}`, workspaceId, workOrderId: `w-${suffix}`,
    uri: `file:///${suffix}.md`, mediaType: "text/markdown", sourceRefs: [], createdAt: new Date().toISOString() });
  store.saveEnergyObservation({ id: `e-${suffix}`, ownerId: `owner-${suffix}`, workspaceId, source: "self_report",
    level: "medium", confidence: "high", aggregate: { responseSeconds: 3 }, observedAt: new Date().toISOString() });
  store.savePlanVersion({ id: `plan-${suffix}`, ownerId: `owner-${suffix}`, workspaceId, version: 1,
    status: "draft", payload: { blocks: [] } });
  store.setSetting(workspaceId, "localActivity.consent", suffix === "a" ? "granted" : "denied");
};

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  seed(A, "a");
  seed(B, "b");
});
afterEach(() => store.close());

test("every list is scoped: neither workspace can see the other's rows", () => {
  const onlyA = (values: string[]) => {
    expect(values.some((value) => value.endsWith("-a"))).toBe(true);
    expect(values.some((value) => value.endsWith("-b"))).toBe(false);
  };
  onlyA(store.listMilestones(A).map((row) => row.id));
  onlyA(store.listWorkOrders(A).map((row) => row.id));
  onlyA(store.listCaptures(A).map((row) => row.id));
  onlyA(store.listMaterials(A).map((row) => row.id));
  onlyA(store.listEnergyObservations(A).map((row) => row.id));
  onlyA(store.listPlanVersions(A).map((row) => row.id));
  // The one that took no workspace at all, and the reason this file exists.
  onlyA(store.listEvents(A).map((row) => row.entityId));
  expect(store.getSetting(A, "localActivity.consent")).toBe("granted");
  expect(store.getSetting(B, "localActivity.consent")).toBe("denied");
});

test("a filtered event read stays inside its workspace", () => {
  // Several call sites used to filter only on `type`, which reads the whole table.
  const created = store.listEvents(A, { type: "capture.created" });
  expect(created).toHaveLength(1);
  expect(created[0]?.entityId).toBe("cap-a");
  expect(store.listEvents(A, { entityId: "cap-b" })).toEqual([]);
});

test("a transition in one workspace leaves the other's identically-shaped work alone", () => {
  store.transitionWorkOrder(A, "w-a", { type: "human.started" }, "start:a");
  expect(store.listWorkOrders(A)[0]?.state).toBe("active");
  expect(store.listWorkOrders(B)[0]?.state).toBe("ready_for_human");
  // The ledger entry lands in A only.
  expect(store.listEvents(B, { type: "work_order.transitioned" })).toEqual([]);
});

test("a snapshot carries one workspace and restores without dragging the other along", () => {
  const snapshot = store.exportSnapshot(A);
  expect(snapshot.workspaceId).toBe(A);
  expect(JSON.stringify(snapshot)).not.toContain("workspace-b");
  expect(JSON.stringify(snapshot)).not.toContain("owner-b");
});
