import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { SOURCE_FOLDERS_SETTING, sourceFolderIndexSetting } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { removeUploadedSource, restoreUploadedSource, saveSourceFiles, UNDO_WINDOW_MS } from "./sources";
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

  const at = Date.UTC(2026, 10, 22);
  expect(removeUploadedSource(TEST_CTX, doc.id, at)).toEqual({ ok: true, fileName: "t.md" });
  expect(store.listSourceDocuments(ws)).toEqual([]);
  expect(unfiledFiles(TEST_CTX, "2026-10-17")).toEqual([]);
  expect(store.listEvents(ws, { type: "source.removed" })).toHaveLength(1);
  expect(removeUploadedSource(TEST_CTX, doc.id, at)).toEqual({ ok: false, code: "SOURCE_NOT_FOUND" });
  // The copy waits out the undo window, then goes with the next removal.
  expect(existsSync(file)).toBe(true);
  const other = saveSourceFiles(TEST_CTX, [{ fileName: "u.md", mediaType: "text/markdown", buffer: Buffer.from("另一行") }]);
  if (!other.ok) throw new Error(other.message);
  removeUploadedSource(TEST_CTX, other.documents[0]!.id, at + UNDO_WINDOW_MS);
  expect(existsSync(file)).toBe(false);
});

test("deleting asks nothing; the notice's undo brings the file back under its id and has it read again, within the window only", async () => {
  const saved = saveSourceFiles(TEST_CTX, [{ fileName: "plan.md", mediaType: "text/markdown", buffer: Buffer.from("计划") }], "ece548");
  if (!saved.ok) throw new Error(saved.message);
  const doc = saved.documents[0]!;
  const at = Date.UTC(2026, 10, 22);
  removeUploadedSource(TEST_CTX, doc.id, at);
  expect(await restoreUploadedSource(TEST_CTX, doc.id, at + 1000)).toEqual({ ok: true, fileName: "plan.md" });
  expect(store.listSourceDocuments(ws)).toMatchObject([{ id: doc.id, projectId: "ece548", extractionStatus: "pending" }]);
  expect(store.listEvents(ws, { type: "source.restored" })).toHaveLength(1);
  expect(await restoreUploadedSource(TEST_CTX, doc.id, at + 2000)).toEqual({ ok: false, code: "SOURCE_NOT_IN_TRASH" });
  removeUploadedSource(TEST_CTX, doc.id, at + 3000);
  expect(await restoreUploadedSource(TEST_CTX, doc.id, at + 3000 + UNDO_WINDOW_MS)).toEqual({ ok: false, code: "SOURCE_NOT_IN_TRASH" });
});

test("one file the app cannot take is refused on its own; the rest of the batch is kept", () => {
  const saved = saveSourceFiles(TEST_CTX, [
    { fileName: "AccessKey.txt", mediaType: "text/plain", buffer: Buffer.from("id,secret") },
    { fileName: "notes.md", mediaType: "text/markdown", buffer: Buffer.from("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx") },
    { fileName: "movie.mkv", mediaType: "video/x-matroska", buffer: Buffer.from("x") },
    { fileName: "plan.md", mediaType: "text/markdown", buffer: Buffer.from("下周写完第三章"), modifiedAt: Date.UTC(2026, 2, 1) }]);
  if (!saved.ok) throw new Error(saved.message);
  expect(saved.documents.map((doc) => doc.fileName)).toEqual(["plan.md"]);
  expect(saved.refused.map((item) => [item.fileName, item.code])).toEqual([["AccessKey.txt", "SOURCE_CREDENTIAL"], ["notes.md", "SOURCE_CREDENTIAL"], ["movie.mkv", "SOURCE_TYPE_NOT_ALLOWED"]]);
  expect(store.getSetting(ws, `sources.modified:${saved.documents[0]!.id}`)).toBe(String(Date.UTC(2026, 2, 1)));
  expect(saveSourceFiles(TEST_CTX, [{ fileName: "server.pem", mediaType: "", buffer: Buffer.from("x") }])).toMatchObject({ ok: false, code: "SOURCE_TYPE_NOT_ALLOWED" });
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
