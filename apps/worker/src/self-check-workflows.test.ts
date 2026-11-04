import { afterEach, beforeEach, expect, test } from "vitest";
import { GROWN_LIBRARY_SETTING, WORKFLOW_FEEDBACK_EVENT, grownSkillFilesKey, type GrownSkillRecord } from "@crossline/core";
import { CrosslineStore, readGrownSkills } from "@crossline/db";
import { ABSORB_DROPPED_EVENT, workflowsProbe } from "./self-check-workflows";

let store: CrosslineStore;
let ws: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
});
afterEach(() => store.close());

const now = new Date("2026-11-04T00:00:00Z");
const xhs = { service: "小红书", site: "https://www.xiaohongshu.com", login: true, how: "读收藏" };
const record = (id: string, extra: Partial<GrownSkillRecord> = {}): GrownSkillRecord => ({ id, kind: "grown", name: id, description: "", lines: ["media"], category: "read_research_organize",
  manifest: { name: id, summary: id, lines: ["media"], category: "read_research_organize", trigger: "on_request", schedule: null, action: "run", reminder: "",
    steps: [{ title: "整理", by: "assistant", external: false }], inputs: [], outputs: [], access: [], risks: [] },
  origin: { kind: "asked", text: "", requestId: "r" }, taskId: "", files: [], scan: { risk: "low", injection: false, findings: [] },
  review: { verdict: "usable", reasons: [], final: "usable" }, status: "active", pinned: false, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
  lastUsedAt: "2026-11-01T00:00:00Z", ...extra });
const save = (...records: GrownSkillRecord[]) => {
  store.setSetting(ws, GROWN_LIBRARY_SETTING, JSON.stringify(records));
  for (const item of records) store.setSetting(ws, grownSkillFilesKey(item.id), JSON.stringify({ files: [] }));
};
const run = () => workflowsProbe(store).run(ws, now);
const event = (type: string, entityId: string, payload: Record<string, unknown>, at: string) =>
  store.appendEvent({ ownerId: "system", workspaceId: ws, idempotencyKey: `${type}:${entityId}:${at}`, type, entityId, payload });

test("no grown workflows: skipped; a healthy one: ok", async () => {
  expect((await run()).status).toBe("skipped");
  save(record("flow-a"));
  expect(await run()).toMatchObject({ status: "ok" });
});

test("files that no longer match the record and versions out of order are reported", async () => {
  save(record("flow-a", { files: [{ path: "SKILL.md", sha256: "0".repeat(64), bytes: 1 }] }));
  expect(await run()).toMatchObject({ status: "failing", code: "WF_FILES_DRIFT" });
  save(record("flow-a", { version: 2 }));
  store.setSetting(ws, "skills.grown.versions.flow-a", JSON.stringify([{ version: 3 }]));
  expect(await run()).toMatchObject({ status: "failing", code: "WF_VERSION_ORDER" });
});

test("a workflow merged into one that is gone is switched back to how it was", async () => {
  save(record("flow-a", { status: "off", mergedInto: { id: "flow-gone", at: "2026-11-02T00:00:00Z", why: "", status: "active" } }));
  expect(await run()).toMatchObject({ status: "repaired", code: "WF_MERGE_DANGLING" });
  expect(readGrownSkills(store, ws)[0]).toMatchObject({ status: "active" });
  expect(readGrownSkills(store, ws)[0]!.mergedInto).toBeUndefined();
});

test("one left waiting for consent although it is within what the person accepted is switched on", async () => {
  const flow = record("flow-a", { status: "needs_consent" });
  save({ ...flow, manifest: { ...flow.manifest, access: [xhs] } });
  // Accepted before steps were recorded with the acceptance.
  event("skill.grown.consented", "flow-a", { id: "flow-a", access: [xhs], risks: [] }, "2026-11-02T00:00:00Z");
  expect(await run()).toMatchObject({ status: "repaired", code: "WF_CONSENT_STALE" });
  expect(readGrownSkills(store, ws)[0]).toMatchObject({ status: "active" });
});

test("a merge reason left after the merge was undone is given up on once", async () => {
  save(record("flow-keep"), record("flow-absorbed"));
  event(WORKFLOW_FEEDBACK_EVENT, "flow-keep", { id: "flow-keep", text: "合并", by: "system", absorbed: "flow-absorbed" }, "2026-11-02T00:00:00Z");
  expect(await run()).toMatchObject({ status: "repaired", code: "WF_ABSORB_AFTER_UNMERGE" });
  expect(store.listEvents(ws, { type: ABSORB_DROPPED_EVENT })).toHaveLength(1);
  expect(await run()).toMatchObject({ status: "ok" });
});
