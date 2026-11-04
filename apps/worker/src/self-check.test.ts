import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SELF_CHECK_SETTING, readSelfCheck } from "@crossline/core";
import { CrosslineStore, listAgentTasks } from "@crossline/db";
import { outputsProbe, selfCheckPass } from "./self-check";

let store: CrosslineStore;
let ws: string;
let owner: string;
let root: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  const created = store.createPrincipalWithWorkspace("user-1", "w");
  ws = created.workspace.id; owner = created.principal.id;
  root = mkdtempSync(path.join(tmpdir(), "self-check-"));
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

const run = (taskId: string, directory: string, files: string[]) => {
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `req:${taskId}`, type: "agent.task.requested", entityId: taskId, payload: { title: taskId, category: "draft_text" } });
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `done:${taskId}`, type: "agent.task.completed", entityId: taskId,
    payload: { directory, artifacts: files.map((file) => ({ path: file, sha256: "h", bytes: 1 })), needsHuman: 0, checksPassed: true, inputsModified: [], reviewRequired: true } });
  store.appendEvent({ ownerId: owner, workspaceId: ws, idempotencyKey: `rev:${taskId}`, type: "agent.task.reviewed", entityId: taskId, payload: { decision: "accepted" } });
};
const folder = (name: string, files: string[]) => {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "audit.json"), "{}");
  for (const file of files) writeFileSync(path.join(dir, file), "x");
  return dir;
};

test("outputs: a foreign folder is found here, lost files leave every surface, and the result is recorded once a day", async () => {
  folder("moved", ["a.md"]);
  run("moved", "C:\Users\someone\Crossline\ai-output\moved", ["a.md"]);
  run("gone", "C:\Users\someone\Crossline\ai-output\gone", ["b.md"]);
  run("half", folder("half", ["c.md"]), ["c.md", "d.md"]);
  const now = new Date("2026-11-04T10:00:00Z");
  const results = await selfCheckPass(store, ws, [outputsProbe(store, root, {})], { now });
  expect(results?.[0]).toMatchObject({ id: "outputs", status: "repaired", code: "OUTPUT_DIR_MISSING" });
  const rows = new Map(listAgentTasks(store, ws).map((row) => [row.taskId, row]));
  expect(rows.get("moved")).toMatchObject({ directory: path.join(root, "moved") });
  expect(rows.get("gone")?.filesGone).toBe(true);
  expect(rows.get("half")?.artifacts.map((artifact) => artifact.path)).toEqual(["c.md"]);
  expect(readSelfCheck(store.getSetting(ws, SELF_CHECK_SETTING))?.results[0]?.status).toBe("repaired");
  // Same day: not run again; forced: everything is now in order.
  expect(await selfCheckPass(store, ws, [outputsProbe(store, root, {})], { now })).toBeUndefined();
  expect((await selfCheckPass(store, ws, [outputsProbe(store, root, {})], { now, force: true }))?.[0]?.status).toBe("ok");
});

test("a probe that throws fails on its own; the others still run", async () => {
  const boom = { id: "mail", run: () => { throw new Error("boom"); } };
  const fine = { id: "node", run: () => ({ status: "ok" as const, code: "", detail: "" }) };
  const results = await selfCheckPass(store, ws, [boom, fine], { now: new Date("2026-11-04T10:00:00Z") });
  expect(results?.map((result) => [result.id, result.status, result.code])).toEqual([["mail", "failing", "PROBE_FAILED"], ["node", "ok", ""]]);
});

test("on the hosted beta an unset output folder is a failure", async () => {
  run("x", folder("x", ["a.md"]), ["a.md"]);
  const results = await selfCheckPass(store, ws, [outputsProbe(store, root, { CROSSLINE_PUBLIC_BETA: "1" })], { now: new Date() });
  expect(results?.[0]).toMatchObject({ status: "failing", code: "OUTPUT_ROOT_UNSET" });
});
