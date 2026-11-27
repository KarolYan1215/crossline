import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { RESULT_FOLDERS_SETTING, SOURCE_FOLDERS_SETTING, sourceFolderIndexSetting } from "@crossline/core";
import { DELIVERABLE_SKILL, deliverableCheckPass, newFolderFiles } from "./deliverable-check";
import { fakeRuntime } from "./testing/fake-runtime";

/** The system's acceptance, the worker's half (docs/plans/attention-ledger-1120.md §7.2): new files judged against tasks, quotes checked. */
let store: CrosslineStore;
let ws: string;
const NOW = new Date("2026-11-21T12:00:00.000Z");
const AUTHORIZED = "2026-11-01T00:00:00.000Z";
const estimate = { p25Minutes: 40, p50Minutes: 60, p85Minutes: 90, source: "llm_prior" as const, observationCount: 0, confidence: "high" as const };
const HW = "Q1. 推导 KCL。\nQ2. 求解电路。\nQ3. 画出波特图。\nQ4. 讨论稳定性。\nQ5. 总结。";

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  const order = (id: string, projectId: string, payload: Record<string, unknown> = {}) => store.saveWorkOrder({ id, ownerId: "user-1", workspaceId: ws, identityId: "research",
    projectId, milestoneId: "", intent: id, state: "approved", riskTier: "routine", estimate, payload });
  order("hw4", "ece555"); order("run", "health", { offline: true }); order("draft", "paper");
  store.setSetting(ws, SOURCE_FOLDERS_SETTING, JSON.stringify([{ id: "f1", path: "C:\\课程", label: "课程", addedAt: AUTHORIZED, lines: [] }]));
  const doc = (id: string, name: string, text: string) => store.saveSourceDocument({ id, ownerId: "user-1", workspaceId: ws, kind: "text", fileName: name, mediaType: "text/plain",
    sha256: id, uri: `file:///C:/课程/${name}`, extractedText: text, extractionStatus: "done", createdAt: AUTHORIZED });
  doc("old", "syllabus.txt", "课程大纲：每周一次作业"); doc("new", "hw4_final.txt", HW); doc("note", "grocery.txt", "牛奶 鸡蛋 面包");
  store.setSetting(ws, sourceFolderIndexSetting("f1"), JSON.stringify({
    // Read at the folder's first reading: never judged, so authorizing a folder completes nothing.
    "syllabus.txt": { size: 1, mtimeMs: Date.parse(AUTHORIZED) - 86_400_000, documentId: "old" },
    "ECE555\\hw4_final.txt": { size: 1, mtimeMs: Date.parse("2026-11-20T10:00:00.000Z"), documentId: "new" },
    "grocery.txt": { size: 1, mtimeMs: Date.parse("2026-11-19T10:00:00.000Z"), documentId: "note" } }));
});
afterEach(() => store.close());

const pass = { doc: "new", task: "hw4", verdict: "deliverable", criterion: "pass", quote: "Q5. 总结。", gap: "", external: true, why: "五题齐全" };
const unrelated = { doc: "note", task: "", verdict: "unrelated", criterion: "cannot_read", quote: "", gap: "", external: false, why: "购物清单" };

test("only files changed after the folder was authorized wait, oldest change first", () => {
  expect(newFolderFiles(store, ws).map((file) => [file.doc.id, file.relative])).toEqual([["note", "grocery.txt"], ["new", "ECE555/hw4_final.txt"]]);
});

test("each new file is judged once; an offline task is never a candidate; the file is filed under its task's project", async () => {
  const runtime = fakeRuntime([JSON.stringify({ items: [unrelated, pass] })], DELIVERABLE_SKILL);
  expect(await deliverableCheckPass(store, ws, runtime.rpc, "C:\\repo", NOW)).toBe(2);
  const prompt = runtime.prompts().join("\n");
  expect(prompt).toContain("hw4");
  expect(prompt).not.toContain("\"run\"");
  const judged = store.listEvents(ws, { type: "deliverable.changed", change: "judged" });
  expect(judged.map((event) => event.entityId).sort()).toEqual(["new", "note"]);
  expect(judged.find((event) => event.entityId === "new")!.payload).toMatchObject({ task: "hw4", verdict: "deliverable", criterion: "pass", fileName: "ECE555/hw4_final.txt" });
  expect(store.listSourceDocuments(ws).find((doc) => doc.id === "new")!.projectId).toBe("ece555");
  expect(newFolderFiles(store, ws)).toEqual([]);
});

test("a quote not in the file is sent back, and the repaired answer is kept", async () => {
  const runtime = fakeRuntime([JSON.stringify({ items: [unrelated, { ...pass, quote: "全部完成" }] }), JSON.stringify({ items: [unrelated, pass] })], DELIVERABLE_SKILL);
  await deliverableCheckPass(store, ws, runtime.rpc, "C:\\repo", NOW);
  expect(runtime.prompts().join("\n")).toContain("quote 必须逐字出自该文件");
  expect(store.listEvents(ws, { type: "deliverable.changed", change: "judged" })).toHaveLength(2);
});

test("a result folder is matched against its project's tasks only", async () => {
  store.setSetting(ws, RESULT_FOLDERS_SETTING, JSON.stringify({ f1: "paper" }));
  const runtime = fakeRuntime([JSON.stringify({ items: [unrelated, { ...unrelated, doc: "new" }] })], DELIVERABLE_SKILL);
  await deliverableCheckPass(store, ws, runtime.rpc, "C:\\repo", NOW);
  const prompt = runtime.prompts().join("\n");
  expect(prompt).toContain("\"draft\"");
  expect(prompt).not.toContain("\"hw4\"");
});
