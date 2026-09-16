import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { persistPreparedMaterials } from "./materials";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const seed = () => {
  const store = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "wo", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "m",
    intent: "Prepare", state: "preparing", riskTier: "milestone", payload: {},
    estimate: { p25Minutes: 1, p50Minutes: 2, p85Minutes: 3, source: "llm_prior", observationCount: 0, confidence: "low" } });
  return store;
};

test("prepared materials stay under the dedicated project folder and become ready", () => {
  const root = mkdtempSync(path.join(tmpdir(), "crossline-materials-")); roots.push(root);
  const store = seed();
  try {
    const result = persistPreparedMaterials(store, { workspaceId: "w", ownerId: "o", workOrderId: "wo", projectRoot: root,
      files: [{ relativePath: "brief.md", content: "source-backed brief", mediaType: "text/markdown", sourceRefs: ["https://example.test/source"] }] });
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(root, ".crossline-materials", "wo", "brief.md"), "utf8")).toBe("source-backed brief");
    expect(store.listMaterials("w", "wo")).toHaveLength(1);
    expect(store.listWorkOrders("w")[0]?.state).toBe("ready_for_human");
  } finally { store.close(); }
});

test("path escape and missing authorization are typed blockers and leave preparation recoverable", () => {
  const root = mkdtempSync(path.join(tmpdir(), "crossline-materials-")); roots.push(root);
  const store = seed();
  try {
    expect(persistPreparedMaterials(store, { workspaceId: "w", ownerId: "o", workOrderId: "wo",
      files: [] })).toMatchObject({ ok: false, blocker: { code: "MATERIAL_PROJECT_ROOT_REQUIRED" } });
    expect(persistPreparedMaterials(store, { workspaceId: "w", ownerId: "o", workOrderId: "wo", projectRoot: root,
      files: [{ relativePath: "..\\outside.md", content: "no", mediaType: "text/markdown", sourceRefs: [] }] }))
      .toMatchObject({ ok: false, blocker: { code: "MATERIAL_PATH_OUTSIDE_ROOT" } });
    expect(store.listWorkOrders("w")[0]?.state).toBe("preparing");
    expect(store.listMaterials("w")).toEqual([]);
  } finally { store.close(); }
});
