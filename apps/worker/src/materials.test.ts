import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { persistAssistantMaterial } from "./materials";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const seed = () => {
  const store = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "wo", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "m",
    intent: "Prepare", state: "active", riskTier: "milestone", payload: {},
    estimate: { p25Minutes: 1, p50Minutes: 2, p85Minutes: 3, source: "llm_prior", observationCount: 0, confidence: "low" } });
  return store;
};
const file = (over: object = {}) => ({ relativePath: "brief.md", content: "note", mediaType: "text/markdown", sourceRefs: [], ...over });

test("a saved snippet lands in the work order's own folder and is recorded, without moving the order", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crossline-materials-")); roots.push(dir);
  const store = seed();
  try {
    const result = persistAssistantMaterial(store, { workspaceId: "w", ownerId: "o", workOrderId: "wo", materialsDir: dir, file: file() });
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(dir, "wo", "brief.md"), "utf8")).toBe("note");
    expect(store.listMaterials("w", "wo")).toHaveLength(1);
    expect(store.listWorkOrders("w")[0]?.state).toBe("active");
  } finally { store.close(); }
});

test("path escape, a missing folder and an overwrite with different content are typed blockers", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "crossline-materials-")); roots.push(dir);
  const store = seed();
  try {
    expect(persistAssistantMaterial(store, { workspaceId: "w", ownerId: "o", workOrderId: "wo", file: file() })).toMatchObject({ ok: false, blocker: { code: "MATERIAL_PROJECT_ROOT_REQUIRED" } });
    expect(persistAssistantMaterial(store, { workspaceId: "w", ownerId: "o", workOrderId: "wo", materialsDir: dir, file: file({ relativePath: "../outside.md" }) }))
      .toMatchObject({ ok: false, blocker: { code: "MATERIAL_PATH_OUTSIDE_ROOT" } });
    expect(persistAssistantMaterial(store, { workspaceId: "w", ownerId: "o", workOrderId: "wo", materialsDir: dir, file: file() }).ok).toBe(true);
    expect(persistAssistantMaterial(store, { workspaceId: "w", ownerId: "o", workOrderId: "wo", materialsDir: dir, file: file({ content: "different" }) }))
      .toMatchObject({ ok: false, blocker: { code: "MATERIAL_ALREADY_EXISTS" } });
  } finally { store.close(); }
});
