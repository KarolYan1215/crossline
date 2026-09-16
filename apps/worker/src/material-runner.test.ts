import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CrosslineStore } from "@crossline/db";
import type { CostSignal } from "@crossline/core";
import { createMaterialPreparer, pendingMaterialWorkOrders, MATERIAL_SKILL } from "./material-runner";
import { fakeRuntime as sharedRuntime } from "./testing/fake-runtime";

const fakeRuntime = (answers: string[]) => sharedRuntime(answers, MATERIAL_SKILL);

const WORKSPACE = "personal-crossline";
let store: CrosslineStore;
let projectRoot: string;

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  projectRoot = mkdtempSync(path.join(tmpdir(), "crossline-materials-"));
  store.saveMilestone({ id: "m", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research",
    projectId: "p", title: "里程碑", version: 1, status: "approved" });
  store.saveWorkOrder({
    id: "w1", ownerId: "local-owner", workspaceId: WORKSPACE, identityId: "research",
    projectId: "p", milestoneId: "m", intent: "准备组会材料", state: "preparing", riskTier: "milestone",
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { materialContract: [{ id: "c0", description: "一页摘要", required: true }], availableInputs: [{ id: "i0", text: "上周记录" }] }
  });
});
afterEach(() => {
  store.close();
  rmSync(projectRoot, { recursive: true, force: true });
});

const healthy: CostSignal = { available: true, limitReached: false,
  short: { usedPercent: 10, windowDurationMins: 300, resetsAt: null },
  long: { usedPercent: 20, windowDurationMins: 10080, resetsAt: null } };

const preparation = {
  artifacts: [{ relativePath: "summary.md", content: "# 组会摘要\n要点一", mediaType: "text/markdown", sourceRefs: ["c0"] }],
  unresolvedQuestions: ["目标读者是谁？"],
  blockers: []
};

test("a prepared work order gets real files on disk and moves to ready_for_human", async () => {
  const { rpc } = fakeRuntime([JSON.stringify(preparation)]);
  const prepare = createMaterialPreparer(store, WORKSPACE, projectRoot, () => rpc, async () => healthy);
  const outcome = await prepare("w1");

  expect(outcome).toMatchObject({ state: "ready", artifacts: 1 });
  const written = path.join(projectRoot, ".crossline-materials", "w1", "summary.md");
  expect(readFileSync(written, "utf8")).toContain("组会摘要");
  // The material reference is what makes the artifact auditable later, not the file alone.
  expect(store.listMaterials(WORKSPACE, "w1")).toHaveLength(1);
  expect(store.listWorkOrders(WORKSPACE)[0]?.state).toBe("ready_for_human");
  // Questions the Skill could not answer belong to the person, so they are kept rather than dropped.
  expect(store.listEvents(WORKSPACE).some((event) => event.type === "materials.questions")).toBe(true);
});

test("a refused preparation leaves the work order in preparing so the human path stays open", async () => {
  const refusal = { artifacts: [], unresolvedQuestions: [],
    blockers: [{ code: "INPUT_UNAVAILABLE", message: "记录不在可用输入里。" }] };
  const { rpc } = fakeRuntime([JSON.stringify(refusal)]);
  const prepare = createMaterialPreparer(store, WORKSPACE, projectRoot, () => rpc, async () => healthy);
  const outcome = await prepare("w1");

  expect(outcome).toMatchObject({ state: "blocked", code: "MATERIAL_BLOCKED" });
  // The Skill's own words, not a generic "run did not finish".
  expect((outcome as { message: string }).message).toBe("记录不在可用输入里。");
  expect(store.listWorkOrders(WORKSPACE)[0]?.state).toBe("preparing");
  expect(store.listMaterials(WORKSPACE, "w1")).toEqual([]);
});

test("a path that escapes the work order folder is refused before anything is written", async () => {
  const escaping = { artifacts: [{ relativePath: "../../stolen.md", content: "x", mediaType: "text/markdown", sourceRefs: ["c0"] }],
    unresolvedQuestions: [], blockers: [] };
  const { rpc } = fakeRuntime([JSON.stringify(escaping)]);
  const prepare = createMaterialPreparer(store, WORKSPACE, projectRoot, () => rpc, async () => healthy);
  const outcome = await prepare("w1");

  expect(outcome).toMatchObject({ state: "blocked", code: "MATERIAL_PATH_OUTSIDE_ROOT" });
  expect(store.listWorkOrders(WORKSPACE)[0]?.state).toBe("preparing");
});

test("preparation does not spend the last of the window on a convenience", async () => {
  const exhausted: CostSignal = { available: true, limitReached: true,
    short: { usedPercent: 100, windowDurationMins: 300, resetsAt: null } };
  const { rpc, turns } = fakeRuntime([JSON.stringify(preparation)]);
  const prepare = createMaterialPreparer(store, WORKSPACE, projectRoot, () => rpc, async () => exhausted);
  expect(await prepare("w1")).toMatchObject({ state: "blocked", code: "MATERIAL_BUDGET_EXHAUSTED" });
  // The refusal has to happen before the turn, or it saved nothing.
  expect(turns()).toBe(0);
});

test("an unreadable cost signal refuses by its own cause rather than guessing zero", async () => {
  const { rpc, turns } = fakeRuntime([JSON.stringify(preparation)]);
  const prepare = createMaterialPreparer(store, WORKSPACE, projectRoot, () => rpc,
    async () => ({ available: false, reason: "CODEX_SUPERVISOR_UNAVAILABLE" }));
  expect(await prepare("w1")).toMatchObject({ state: "blocked", code: "COST_SIGNAL_UNAVAILABLE" });
  expect(turns()).toBe(0);
});

test("a preparation that already failed is not retried on every tick", async () => {
  expect(pendingMaterialWorkOrders(store, WORKSPACE)).toEqual(["w1"]);
  const refusal = { artifacts: [], unresolvedQuestions: [], blockers: [{ code: "X", message: "不行。" }] };
  const { rpc } = fakeRuntime([JSON.stringify(refusal)]);
  await createMaterialPreparer(store, WORKSPACE, projectRoot, () => rpc, async () => healthy)("w1");
  // Re-running the Skill every 15 minutes would burn quota with no new information; the human
  // self-preparation path is open the whole time.
  expect(pendingMaterialWorkOrders(store, WORKSPACE)).toEqual([]);
});
