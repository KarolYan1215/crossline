import { afterEach, beforeEach, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CrosslineStore } from "@crossline/db";
import { TEST_CTX } from "../../../../../lib/test-support";
vi.mock("../../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

// Same cwd-spy technique as `lib/attachments.test.ts` — this route calls straight through to the real
// `saveAssistantAttachments`, so its `PROJECT_ROOT` has to resolve into a disposable temp directory
// rather than wherever the test runner's own cwd happens to be.
let tmpRoot: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "crossline-assistant-attachments-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(path.join(tmpRoot, "apps", "web"));
  vi.resetModules();
  globalThis.crosslineStore = new CrosslineStore(":memory:");
});
afterEach(() => {
  globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined;
  cwdSpy.mockRestore();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const params = (threadId: string) => ({ params: Promise.resolve({ threadId }) });

test("POST refuses a forged Origin", async () => {
  const route = await import("./route");
  const response = await route.POST(new Request("http://localhost/api/assistant/t1/attachments", {
    method: "POST", headers: { origin: "https://evil.example" }
  }), params("t1"));
  expect(response.status).toBe(403);
});

test("POST refuses an invalid threadId without touching the store", async () => {
  const route = await import("./route");
  const response = await route.POST(new Request("http://localhost/api/assistant/bad id/attachments", { method: "POST" }), params("bad id"));
  expect(response.status).toBe(400);
});

test("POST saves an uploaded file and returns its id, filename and media type", async () => {
  const route = await import("./route");
  const form = new FormData();
  form.append("file", new File(["hello"], "notes.txt", { type: "text/plain" }));
  const response = await route.POST(new Request("http://localhost/api/assistant/t1/attachments", { method: "POST", body: form }), params("t1"));
  expect(response.status).toBe(200);
  const body = await response.json() as { saved: Array<{ id: string; fileName: string; mediaType: string }> };
  expect(body.saved).toHaveLength(1);
  expect(body.saved[0]).toMatchObject({ fileName: "notes.txt", mediaType: "text/plain" });
  expect(globalThis.crosslineStore!.listAssistantAttachments(TEST_CTX.workspaceId, "t1")).toHaveLength(1);
});

test("POST refuses an unsupported media type and writes nothing", async () => {
  const route = await import("./route");
  const form = new FormData();
  form.append("file", new File(["x"], "a.exe", { type: "application/x-executable" }));
  const response = await route.POST(new Request("http://localhost/api/assistant/t1/attachments", { method: "POST", body: form }), params("t1"));
  expect(response.status).toBe(400);
  expect(globalThis.crosslineStore!.listAssistantAttachments(TEST_CTX.workspaceId, "t1")).toHaveLength(0);
});

test("GET serves back a previously saved attachment by its uri", async () => {
  const { saveAssistantAttachments } = await import("../../../../../lib/attachments");
  const saved = saveAssistantAttachments(globalThis.crosslineStore!, {
    workspaceId: TEST_CTX.workspaceId, ownerId: TEST_CTX.principalId, threadId: "t1",
    files: [{ fileName: "notes.txt", mediaType: "text/plain", buffer: Buffer.from("hello") }]
  });
  if (!saved.ok) throw new Error("setup failed");
  const uri = saved.saved[0]!.uri;
  const route = await import("./route");
  const response = await route.GET(new Request(`http://localhost/api/assistant/t1/attachments?uri=${encodeURIComponent(uri)}`), params("t1"));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("hello");
});

test("GET returns 404 for a uri that was never saved for this thread", async () => {
  const route = await import("./route");
  const response = await route.GET(new Request("http://localhost/api/assistant/t1/attachments?uri=file:///nope"), params("t1"));
  expect(response.status).toBe(404);
});
