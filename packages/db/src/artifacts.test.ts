import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterEach, expect, test } from "vitest";
import { byproductArtifactId, deriveArtifactRelations, type StoredArtifactPlan } from "@crossline/core";
import {
  approveArtifactRelationsFor, CrosslineStore, handOffArtifacts, linkArtifactWork, recordRelationCheck, relationChecks, relationsDueForCheck,
  removeArtifactRelation, retireUnderivedRelations, saveStoredArtifactPlan, syncArtifactRelations, type StoredWorkOrder
} from "./index";

const W = "w";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(path.join(tmpdir(), "crossline-artifacts-")); dirs.push(dir); return dir; };

const estimate = { p25Minutes: 60, p50Minutes: 90, p85Minutes: 150, source: "llm_prior" as const, observationCount: 0, confidence: "low" as const };
const plan: StoredArtifactPlan = { version: 1, updatedAt: "t", needs: [],
  artifacts: [{ id: "research-figs", line: "research", kind: "论文图表", title: "MoS2 仿真图表", readyBy: "2026-10-20" }],
  supplies: [{ from: "research-figs", toLine: "media", use: "第 2 期视频配图", transfer: { metric: "图表", expected: 3, unit: "张" }, lagDays: 3,
    counterfactual: "没有这些图要自己重画，多花约 6 小时", hoursSaved: 6 }] };

function board(store: CrosslineStore, status: { up?: "draft" | "approved"; down?: "draft" | "approved" } = {}) {
  store.saveMilestone({ id: "up", ownerId: "o", workspaceId: W, identityId: "research", projectId: "p", title: "图表交付师兄确认", version: 1, status: status.up ?? "draft" });
  store.saveMilestone({ id: "down", ownerId: "o", workspaceId: W, identityId: "media", projectId: "m", title: "第 2 期视频发布", version: 1, status: status.down ?? "draft" });
  const anchor = { workspaceId: W, stage: 1, baseline: "", target: "", stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "t" };
  store.saveMilestoneAnchor({ ...anchor, milestoneId: "up", deadline: "2026-10-20", outputs: ["research-figs"], inputs: [] });
  store.saveMilestoneAnchor({ ...anchor, milestoneId: "down", deadline: "2026-11-01", outputs: [], inputs: ["research-figs"] });
  saveStoredArtifactPlan(store, W, plan);
}
const derive = (store: CrosslineStore) => {
  const anchors = new Map(store.listMilestoneAnchors(W).map((anchor) => [anchor.milestoneId, anchor]));
  return deriveArtifactRelations(store.listMilestones(W).filter((milestone) => milestone.status !== "archived").map((milestone) => ({ id: milestone.id,
    line: milestone.identityId, title: milestone.title, status: milestone.status, deadline: anchors.get(milestone.id)?.deadline,
    outputs: anchors.get(milestone.id)?.outputs ?? [], inputs: anchors.get(milestone.id)?.inputs ?? [] })), plan).relations;
};

test("migration 13 adds the artifact columns to an existing ledger, keeping its rows, and leaves a copy of the old file", () => {
  const dir = tempDir();
  const file = path.join(dir, "ledger.db");
  new CrosslineStore(file).close();
  const raw = new Database(file);
  for (const [table, column] of [["milestone_anchors", "outputs_json"], ["milestone_anchors", "inputs_json"], ["milestone_relations", "artifact_id"],
    ["milestone_relations", "transfer_json"], ["milestone_relations", "check_on"], ["milestone_relations", "counterfactual"]]) raw.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  raw.exec(`INSERT INTO milestone_anchors (workspace_id, milestone_id, stage, deadline, baseline, target, updated_at) VALUES ('${W}', 'm1', 1, '2026-11-01', '', '', 't');
    INSERT INTO milestone_relations (id, owner_id, workspace_id, from_milestone_id, to_milestone_id, kind, status, updated_at, evidence_json, counterexample_json)
    VALUES ('old', 'o', '${W}', 'a', 'b', 'informs', 'candidate', 't', '[]', '[]');`);
  raw.pragma("user_version = 12");
  raw.close();
  const store = new CrosslineStore(file);
  expect(store.schemaVersion()).toBeGreaterThanOrEqual(13);
  expect(store.listMilestoneAnchors(W)[0]).toMatchObject({ milestoneId: "m1", outputs: [], inputs: [] });
  expect(store.listMilestoneRelations(W)[0]).toMatchObject({ id: "old", artifactId: null, transfer: null, checkOn: null, counterfactual: null });
  store.close();
  const backup = new Database(path.join(dir, "ledger.db.v12.bak"), { readonly: true });
  expect(backup.pragma("user_version", { simple: true })).toBe(12);
  backup.close();
});

test("artifact references and relation fields survive a snapshot export and import; a save that leaves them out keeps them", () => {
  const store = new CrosslineStore(":memory:");
  board(store);
  syncArtifactRelations(store, W, "o", derive(store));
  store.saveMilestoneAnchor({ workspaceId: W, milestoneId: "up", stage: 1, deadline: "2026-10-19", baseline: "", target: "", stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "t2" });
  expect(store.listMilestoneAnchors(W).find((anchor) => anchor.milestoneId === "up")).toMatchObject({ deadline: "2026-10-19", outputs: ["research-figs"] });
  const snapshot = store.exportSnapshot(W);
  const restored = new CrosslineStore(":memory:");
  restored.importSnapshot(snapshot);
  expect(restored.listMilestoneAnchors(W)).toEqual(store.listMilestoneAnchors(W));
  expect(restored.listMilestoneRelations(W)).toEqual(store.listMilestoneRelations(W));
  expect(restored.listMilestoneRelations(W)[0]).toMatchObject({ artifactId: "research-figs", checkOn: "2026-11-01", transfer: { expected: 3, unit: "张", measured: null } });
  expect(restored.getSetting(W, "flywheel.artifacts")).toBe(store.getSetting(W, "flywheel.artifacts"));
  // A snapshot taken before migration 13 has no such columns: it still restores.
  const old = structuredClone(snapshot);
  for (const row of old.tables.milestone_relations!) { delete row.artifact_id; delete row.transfer_json; delete row.check_on; delete row.counterfactual; }
  for (const row of old.tables.milestone_anchors!) { delete row.outputs_json; delete row.inputs_json; }
  const older = new CrosslineStore(":memory:");
  older.importSnapshot(old);
  expect(older.listMilestoneRelations(W)[0]).toMatchObject({ artifactId: null, transfer: null });
  expect(older.listMilestoneAnchors(W)[0]!.outputs).toEqual([]);
  for (const item of [store, restored, older]) item.close();
});

test("a derived relation is a candidate until its downstream milestone is approved, and is approved with it", () => {
  const store = new CrosslineStore(":memory:");
  board(store);
  const { saved } = syncArtifactRelations(store, W, "o", derive(store));
  expect(saved).toEqual(["artifact:research-figs:up->down"]);
  expect(store.listMilestoneRelations(W)[0]).toMatchObject({ status: "candidate", kind: "reuses", counterfactual: plan.supplies[0]!.counterfactual });
  // Approving the upstream alone decides nothing: the relation follows its downstream milestone.
  store.saveMilestone({ ...store.getMilestone(W, "up")!, version: 2, status: "approved" });
  expect(approveArtifactRelationsFor(store, W, "o", "up")).toEqual([]);
  store.saveMilestone({ ...store.getMilestone(W, "down")!, version: 2, status: "approved" });
  expect(approveArtifactRelationsFor(store, W, "o", "down")).toEqual(["artifact:research-figs:up->down"]);
  expect(store.listMilestoneRelations(W)[0]!.status).toBe("approved");
  store.close();
});

test("a relation into an already approved downstream milestone is approved when its upstream is", () => {
  const store = new CrosslineStore(":memory:");
  board(store, { down: "approved" });
  syncArtifactRelations(store, W, "o", derive(store));
  expect(store.listMilestoneRelations(W)[0]!.status).toBe("candidate");
  store.saveMilestone({ ...store.getMilestone(W, "up")!, version: 2, status: "approved" });
  expect(approveArtifactRelationsFor(store, W, "o", "up")).toHaveLength(1);
  store.close();
});

test("a removed relation is never derived again; one whose ends are gone is retired, one derived again is not", () => {
  const store = new CrosslineStore(":memory:");
  board(store);
  syncArtifactRelations(store, W, "o", derive(store));
  store.saveMilestoneRelation({ id: "proposed:x->down:informs", ownerId: "o", workspaceId: W, fromMilestoneId: "gone", toMilestoneId: "down", kind: "informs", status: "candidate" });
  expect(retireUnderivedRelations(store, W, new Set(derive(store).map((relation) => relation.id)))).toEqual(["proposed:x->down:informs"]);
  expect(removeArtifactRelation(store, W, "o", "artifact:research-figs:up->down")).toEqual({ ok: true });
  expect(syncArtifactRelations(store, W, "o", derive(store)).skipped).toEqual(["artifact:research-figs:up->down"]);
  expect(store.listMilestoneRelations(W)).toEqual([]);
  expect(store.preferenceLines(W, ["research"]).join("")).toContain("不采用「图表交付师兄确认」供「第 2 期视频发布」的飞轮关系");
  store.close();
});

test("the check: 兑现 records the promised amount, 没有 refutes the relation, and each answer counts once", () => {
  const store = new CrosslineStore(":memory:");
  board(store, { up: "approved", down: "approved" });
  syncArtifactRelations(store, W, "o", derive(store));
  expect(relationsDueForCheck(store, W, "2026-10-31")).toEqual([]);
  expect(relationsDueForCheck(store, W, "2026-11-01").map((relation) => relation.id)).toEqual(["artifact:research-figs:up->down"]);
  expect(recordRelationCheck(store, W, "o", "artifact:research-figs:up->down", "none", undefined, "图表没做出来")).toEqual({ ok: true });
  const refuted = store.getMilestoneRelation(W, "artifact:research-figs:up->down")!;
  expect(refuted).toMatchObject({ status: "refuted", transfer: { measured: 0 } });
  expect(refuted.counterexample[0]!.note).toBe("图表没做出来");
  expect(relationChecks(store, W)).toEqual([expect.objectContaining({ outcome: "none", kind: "论文图表" })]);
  expect(relationsDueForCheck(store, W, "2026-11-05")).toEqual([]);
  store.close();
});

const order = (over: Partial<StoredWorkOrder> & { id: string; identityId: string; payload: Record<string, unknown> }): StoredWorkOrder => ({
  ownerId: "o", workspaceId: W, projectId: `${over.identityId}-project`, milestoneId: "", intent: over.id, state: "approved", riskTier: "routine", estimate, ...over
});

test("a task that uses an artifact waits for the task producing it, across lines, and never the other way round", () => {
  const store = new CrosslineStore(":memory:");
  store.saveWorkOrder(order({ id: "make-figs", identityId: "research", payload: { produces: "research-figs" } }));
  store.saveWorkOrder(order({ id: "video", identityId: "media", payload: { uses: ["research-figs"], dependsOn: ["script"] } }));
  expect(linkArtifactWork(store, W)).toEqual(["video"]);
  expect((store.listWorkOrders(W).find((item) => item.id === "video")!.payload as { dependsOn: string[] }).dependsOn).toEqual(["script", "make-figs"]);
  expect(linkArtifactWork(store, W)).toEqual([]);
  store.close();
});

test("delivering the producing task hands its files to the using task: filed under its project, noted, and its steps re-planned", () => {
  const store = new CrosslineStore(":memory:");
  const dir = tempDir();
  const file = path.join(dir, "figures.md");
  writeFileSync(file, "# 图 1\n器件 I-V 曲线", "utf8");
  store.saveWorkOrder(order({ id: "make-figs", identityId: "research", state: "ready_for_human", payload: { produces: "research-figs" } }));
  store.saveWorkOrder(order({ id: "video", identityId: "media", payload: { uses: ["research-figs"] } }));
  store.saveStepPlan(W, "video", { archetypeId: "problem_set", quantity: { basis: "期", amount: 1, unit: "期" }, rationale: "", steps: [] }, "o", "t");
  store.transitionWorkOrder(W, "make-figs", { type: "human.started" }, "start:figs", { durationObserved: true });
  store.transitionWorkOrder(W, "make-figs", { type: "human.completed" }, "done:figs", { evidence: [{ kind: "file", uri: pathToFileURL(file).href, description: "图表" }] });
  const docs = store.listSourceDocuments(W, { projectId: "media-project" });
  expect(docs).toEqual([expect.objectContaining({ fileName: "figures.md", kind: "text", extractionStatus: "done", extractedText: expect.stringContaining("I-V 曲线") })]);
  expect(store.listEvents(W, { type: "artifact.handed_off", entityId: "video" })).toHaveLength(1);
  expect(store.listEvents(W, { type: "task.steps_replan_requested", entityId: "video" })).toHaveLength(1);
  expect((store.listEvents(W, { type: "task.note", entityId: "video" })[0]!.payload as { text: string }).text).toContain("figures.md");
  // Once per (artifact, producer, user).
  expect(handOffArtifacts(store, W)).toEqual([]);
  store.close();
});

test("a handed-off file is copied into the ledger's sources folder, where the 材料 link can open it", () => {
  const dir = tempDir();
  const store = new CrosslineStore(path.join(dir, "crossline.db"));
  const outside = path.join(tempDir(), "agent-output.csv");
  writeFileSync(outside, "a,b", "utf8");
  store.saveWorkOrder(order({ id: "make-figs", identityId: "research", state: "ready_for_human", payload: { produces: "research-figs" } }));
  store.saveWorkOrder(order({ id: "video", identityId: "media", payload: { uses: ["research-figs"] } }));
  store.transitionWorkOrder(W, "make-figs", { type: "human.started" }, "start", { durationObserved: true });
  store.transitionWorkOrder(W, "make-figs", { type: "human.completed" }, "done", { evidence: [{ kind: "file", uri: pathToFileURL(outside).href, description: "表" }] });
  const doc = store.listSourceDocuments(W, { projectId: "media-project" })[0]!;
  expect(path.relative(path.join(dir, "sources"), fileURLToPath(doc.uri)).startsWith("..")).toBe(false);
  expect(doc).toMatchObject({ fileName: "agent-output.csv", extractedText: "a,b" });
  store.close();
});

test("a byproduct is an artifact of its main task: the landing task uses it and is handed the main task's files", () => {
  const store = new CrosslineStore(":memory:");
  const dir = tempDir();
  const file = path.join(dir, "diary.txt");
  writeFileSync(file, "调参记录", "utf8");
  store.saveMilestone({ id: "media-m", ownerId: "o", workspaceId: W, identityId: "media", projectId: "xhs", title: "首轮内容获真实反馈", version: 1, status: "approved" });
  store.saveWorkOrder(order({ id: "sim", identityId: "research", state: "awaiting_plan_approval",
    payload: { byproducts: [{ lineId: "media", milestoneId: "media-m", artifact: "一篇研究日记笔记", captureSteps: [], landing: { minutes: 40, description: "改成草稿" }, why: "素材" }] } }));
  store.transitionWorkOrder(W, "sim", { type: "plan.approved", approvalId: "o" }, "approve:sim");
  const landing = store.listWorkOrders(W).find((item) => item.id === "landing-sim-media")!;
  expect(landing.payload).toMatchObject({ uses: [byproductArtifactId("sim", "media")], dependsOn: ["sim"], byproductOf: "sim" });
  store.transitionWorkOrder(W, "sim", { type: "materials.not_required" }, "ready:sim");
  store.transitionWorkOrder(W, "sim", { type: "human.started" }, "start:sim", { durationObserved: true });
  store.transitionWorkOrder(W, "sim", { type: "human.completed" }, "done:sim", { evidence: [{ kind: "file", uri: pathToFileURL(file).href, description: "日记" }] });
  expect(store.listSourceDocuments(W, { projectId: "xhs" }).map((doc) => doc.fileName)).toEqual(["diary.txt"]);
  expect(store.listEvents(W, { type: "artifact.handed_off", entityId: "landing-sim-media" })).toHaveLength(1);
  store.close();
});
