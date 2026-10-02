import { afterEach, beforeEach, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CrosslineStore } from "@crossline/db";

// `PROJECT_ROOT` in attachments.ts is `path.resolve(process.cwd(), "..", "..")`, computed once at module
// import time (the real app always runs with cwd = apps/web). Spying on `process.cwd()` before a fresh
// dynamic import lets this test point it at a disposable temp directory shaped the same way
// (`<tmp>/apps/web`), rather than writing real files under wherever the test runner's own cwd happens to
// resolve two levels up from.
let tmpRoot: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "crossline-attachments-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(path.join(tmpRoot, "apps", "web"));
  vi.resetModules();
});
afterEach(() => {
  cwdSpy.mockRestore();
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("saveCaptureAttachments refuses an invalid capture id before touching disk", async () => {
  const { saveCaptureAttachments } = await import("./attachments");
  const store = new CrosslineStore(":memory:");
  const result = saveCaptureAttachments(store, {
    workspaceId: "w", ownerId: "o", captureId: "../escape",
    files: [{ fileName: "a.txt", mediaType: "text/plain", buffer: Buffer.from("hi") }]
  });
  expect(result).toMatchObject({ ok: false, code: "ATTACHMENT_CAPTURE_ID_INVALID" });
  store.close();
});

test("saveCaptureAttachments refuses an unsupported media type", async () => {
  const { saveCaptureAttachments } = await import("./attachments");
  const store = new CrosslineStore(":memory:");
  const result = saveCaptureAttachments(store, {
    workspaceId: "w", ownerId: "o", captureId: "c1",
    files: [{ fileName: "a.exe", mediaType: "application/x-executable", buffer: Buffer.from("hi") }]
  });
  expect(result).toMatchObject({ ok: false, code: "ATTACHMENT_TYPE_NOT_ALLOWED" });
  store.close();
});

test("saveCaptureAttachments refuses a file over the size limit", async () => {
  const { saveCaptureAttachments } = await import("./attachments");
  const store = new CrosslineStore(":memory:");
  const result = saveCaptureAttachments(store, {
    workspaceId: "w", ownerId: "o", captureId: "c1",
    files: [{ fileName: "a.txt", mediaType: "text/plain", buffer: Buffer.alloc(11 * 1024 * 1024) }]
  });
  expect(result).toMatchObject({ ok: false, code: "ATTACHMENT_TOO_LARGE" });
  store.close();
});

test("saveCaptureAttachments writes the file under attachmentsRoot and records a matching ledger row", async () => {
  const { saveCaptureAttachments, attachmentsRoot } = await import("./attachments");
  const store = new CrosslineStore(":memory:");
  const result = saveCaptureAttachments(store, {
    workspaceId: "w", ownerId: "o", captureId: "c1",
    files: [{ fileName: "notes.txt", mediaType: "text/plain", buffer: Buffer.from("hello") }]
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.saved).toHaveLength(1);
  const saved = result.saved[0]!;
  expect(saved.uri.startsWith(pathToFileURL(attachmentsRoot("c1")).href)).toBe(true);
  expect(readFileSync(new URL(saved.uri), "utf8")).toBe("hello");
  const rows = store.listCaptureAttachments("w", "c1");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: saved.id, uri: saved.uri, mediaType: "text/plain", fileName: "notes.txt" });
  store.close();
});

test("saveAssistantAttachments refuses an invalid thread id before touching disk", async () => {
  const { saveAssistantAttachments } = await import("./attachments");
  const store = new CrosslineStore(":memory:");
  const result = saveAssistantAttachments(store, {
    workspaceId: "w", ownerId: "o", threadId: "not valid!",
    files: [{ fileName: "a.txt", mediaType: "text/plain", buffer: Buffer.from("hi") }]
  });
  expect(result).toMatchObject({ ok: false, code: "ATTACHMENT_THREAD_ID_INVALID" });
  store.close();
});

test("saveAssistantAttachments writes under its own root (not the capture one) and records a ledger row", async () => {
  const { saveAssistantAttachments, assistantAttachmentsRoot, attachmentsRoot } = await import("./attachments");
  const store = new CrosslineStore(":memory:");
  const result = saveAssistantAttachments(store, {
    workspaceId: "w", ownerId: "o", threadId: "t1",
    files: [{ fileName: "plan.txt", mediaType: "text/plain", buffer: Buffer.from("draft") }]
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const saved = result.saved[0]!;
  expect(saved.uri.startsWith(pathToFileURL(assistantAttachmentsRoot("t1")).href)).toBe(true);
  expect(assistantAttachmentsRoot("t1")).not.toBe(attachmentsRoot("t1"));
  const rows = store.listAssistantAttachments("w", "t1");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: saved.id, uri: saved.uri, mediaType: "text/plain", fileName: "plan.txt" });
  store.close();
});
