import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RECORDING_CONSENT, RECORDING_TRANSCRIBED_EVENT, SOURCE_FOLDERS_SETTING, sourceFolderIndexSetting } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { recordingOverview, setRecordingConsent } from "./recordings";

let store: CrosslineStore;
let workspaceId: string;
let ownerId: string;
let data: string;
let file: string;

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  const created = store.createPrincipalWithWorkspace("user-1", "个人 workspace");
  workspaceId = created.workspace.id; ownerId = created.principal.id;
  data = mkdtempSync(path.join(tmpdir(), "crossline-recordings-web-"));
  mkdirSync(path.join(data, "sources"));
  file = path.join(data, "sources", "abc.txt");
  writeFileSync(file, "[00:20] 今天下午三点组会");
  store.saveSourceDocument({ id: "doc-1", ownerId, workspaceId, kind: "text", fileName: "phone/a.m4a 转写.txt", mediaType: "text/plain", sha256: "abc",
    uri: pathToFileURL(file).href, extractedText: "[00:20] 今天下午三点组会", extractionStatus: "done", createdAt: "2026-10-20T15:00:00Z" });
  store.appendEvent({ ownerId, workspaceId, idempotencyKey: "recording.transcribed:sha", type: RECORDING_TRANSCRIBED_EVENT, entityId: "sha",
    payload: { fileName: "a.m4a", seconds: 3600, speechSeconds: 1200, workMs: 6 * 60_000, wallMs: 7 * 60_000, documentId: "doc-1" } });
  store.setSetting(workspaceId, SOURCE_FOLDERS_SETTING, JSON.stringify([{ id: "f1", path: "C:\\phone", label: "phone", addedAt: "", lines: [], linesBy: "" }]));
  store.setSetting(workspaceId, sourceFolderIndexSetting("f1"), JSON.stringify({ "a.m4a": { size: 1, mtimeMs: 1, documentId: "doc-1", audio: "done", created: true },
    "b.m4a": { size: 1, mtimeMs: 2, documentId: "", audio: "queued" }, "c.m4a": { size: 1, mtimeMs: 3, documentId: "", audio: "failed", note: "格式读不了" } }));
});
afterEach(() => { store.close(); rmSync(data, { recursive: true, force: true }); });

test("the overview counts what is done, waiting and failed, and the cost per hour of recording", () => {
  store.setSetting(workspaceId, RECORDING_CONSENT, "granted");
  expect(recordingOverview(store, workspaceId)).toEqual({ on: true, folders: 1, queued: 1, done: 1, silent: 0,
    failed: [{ file: "phone/c.m4a", note: "格式读不了" }], cost: { recordings: 1, audioHours: 1, minutesPerHour: 6 } });
});

test("turned off with the transcripts kept, they stay in the materials", () => {
  store.setSetting(workspaceId, RECORDING_CONSENT, "granted");
  expect(setRecordingConsent(store, workspaceId, false, { keep: true, dataDir: data, ownerId })).toEqual({ deleted: 0 });
  expect(store.getSetting(workspaceId, RECORDING_CONSENT)).toBe("denied");
  expect(store.listSourceDocuments(workspaceId).map((doc) => doc.id)).toEqual(["doc-1"]);
  expect(existsSync(file)).toBe(true);
});

test("turned off with the transcripts deleted, their rows and files go and the recordings are not redone", () => {
  store.setSetting(workspaceId, RECORDING_CONSENT, "granted");
  expect(setRecordingConsent(store, workspaceId, false, { keep: false, dataDir: data, ownerId })).toEqual({ deleted: 1 });
  expect(store.listSourceDocuments(workspaceId)).toEqual([]);
  expect(existsSync(file)).toBe(false);
  const index = JSON.parse(store.getSetting(workspaceId, sourceFolderIndexSetting("f1"))!) as Record<string, { audio?: string; documentId: string }>;
  expect(index["a.m4a"]).toMatchObject({ audio: "done", documentId: "" });
});
