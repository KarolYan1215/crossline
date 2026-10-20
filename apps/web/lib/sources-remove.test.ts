import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { SOURCE_FOLDERS_SETTING, sourceFolderIndexSetting } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { removeUploadedSource, saveSourceFiles } from "./sources";
import { unfiledFiles } from "./file-belonging";
import { TEST_CTX } from "./test-support";

const ws = TEST_CTX.workspaceId;
let dir: string;
let store: CrosslineStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "crossline-source-remove-"));
  vi.stubEnv("CROSSLINE_DATA_DIR", dir);
  vi.stubEnv("CROSSLINE_SEED_EXAMPLES", "");
  store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveProject({ id: "ece548", ownerId: "o", workspaceId: ws, identityId: "research", name: "ECE 548", status: "active", summary: "",
    createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
});
afterEach(() => { store.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); });

// W-6: a file uploaded by mistake had no way out and kept being asked about as a project's material.
test("a mistaken upload is taken back: its row, its stored copy and the question about it all go", () => {
  const saved = saveSourceFiles(TEST_CTX, [{ fileName: "t.md", mediaType: "text/markdown", buffer: Buffer.from("随手一行") }]);
  if (!saved.ok) throw new Error(saved.message);
  const doc = saved.documents[0]!;
  store.setSourceDocumentExtraction(ws, doc.id, { status: "done", text: "随手一行" });
  expect(unfiledFiles(TEST_CTX, "2026-10-17").map((file) => file.id)).toContain(doc.id);
  const file = fileURLToPath(doc.uri);
  expect(existsSync(file)).toBe(true);

  expect(removeUploadedSource(TEST_CTX, doc.id)).toEqual({ ok: true, fileName: "t.md" });
  expect(store.listSourceDocuments(ws)).toEqual([]);
  expect(existsSync(file)).toBe(false);
  expect(unfiledFiles(TEST_CTX, "2026-10-17")).toEqual([]);
  expect(store.listEvents(ws, { type: "source.removed" })).toHaveLength(1);
  expect(removeUploadedSource(TEST_CTX, doc.id)).toEqual({ ok: false, code: "SOURCE_NOT_FOUND" });
});

test("the same content another workspace uploaded keeps its copy; a folder's file is excluded in its own card", () => {
  const other = { ...TEST_CTX, workspaceId: "ws-other" };
  const mine = saveSourceFiles(TEST_CTX, [{ fileName: "a.txt", mediaType: "text/plain", buffer: Buffer.from("同一份") }]);
  const theirs = saveSourceFiles(other, [{ fileName: "b.txt", mediaType: "text/plain", buffer: Buffer.from("同一份") }]);
  if (!mine.ok || !theirs.ok) throw new Error("not saved");
  expect(removeUploadedSource(TEST_CTX, mine.documents[0]!.id)).toMatchObject({ ok: true });
  expect(existsSync(fileURLToPath(theirs.documents[0]!.uri))).toBe(true);
  expect(removeUploadedSource(TEST_CTX, theirs.documents[0]!.id)).toEqual({ ok: false, code: "SOURCE_NOT_FOUND" });

  const kept = saveSourceFiles(TEST_CTX, [{ fileName: "c.txt", mediaType: "text/plain", buffer: Buffer.from("文件夹里的") }]);
  if (!kept.ok) throw new Error(kept.message);
  const second = kept.documents[0];

  store.setSetting(ws, SOURCE_FOLDERS_SETTING, JSON.stringify([{ id: "f1", path: "/home/x/notes", label: "notes", addedAt: "2026-10-01T00:00:00Z", lines: [], linesBy: "model" }]));
  store.setSetting(ws, sourceFolderIndexSetting("f1"), JSON.stringify({ "b.txt": { documentId: second!.id, size: 1, mtimeMs: 1 } }));
  expect(removeUploadedSource(TEST_CTX, second!.id)).toEqual({ ok: false, code: "SOURCE_FROM_FOLDER" });
});
