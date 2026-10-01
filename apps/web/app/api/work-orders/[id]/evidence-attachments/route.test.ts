import { afterEach, beforeEach, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { CrosslineStore } from "@crossline/db";
import { TEST_CTX } from "../../../../../lib/test-support";
vi.mock("../../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: TEST_CTX }) }));

// Same cwd-spy technique as `lib/attachments.test.ts` — this route calls straight through to the real
// `saveEvidenceFile`, so its `PROJECT_ROOT` has to resolve into a disposable temp directory.
let tmpRoot: string;
let cwdSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(tmpdir(), "crossline-evidence-attachments-"));
  cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(path.join(tmpRoot, "apps", "web"));
  vi.resetModules();
  globalThis.crosslineStore = new CrosslineStore(":memory:");
});
afterEach(() => {
  globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined;
  cwdSpy.mockRestore();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });

const seedActive = () => globalThis.crosslineStore!.saveWorkOrder({
  id: "w1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
  projectId: "p", milestoneId: "m", intent: "写材料", state: "active", riskTier: "milestone",
  estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
  payload: {}
});

test("POST refuses a forged Origin", async () => {
  seedActive();
  const route = await import("./route");
  const response = await route.POST(new Request("http://localhost/api/work-orders/w1/evidence-attachments", {
    method: "POST", headers: { origin: "https://evil.example" }
  }), params("w1"));
  expect(response.status).toBe(403);
});

test("POST refuses an order that is not active", async () => {
  globalThis.crosslineStore!.saveWorkOrder({
    id: "w1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
    projectId: "p", milestoneId: "m", intent: "写材料", state: "ready_for_human", riskTier: "milestone",
    estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: {}
  });
  const route = await import("./route");
  const form = new FormData();
  form.append("file", new File(["hello"], "note.txt", { type: "text/plain" }));
  const response = await route.POST(new Request("http://localhost/api/work-orders/w1/evidence-attachments", { method: "POST", body: form }), params("w1"));
  expect(response.status).toBe(409);
});

test("POST saves an uploaded evidence file under this work order's own root and returns its uri", async () => {
  seedActive();
  const route = await import("./route");
  const form = new FormData();
  form.append("file", new File(["hello"], "note.txt", { type: "text/plain" }));
  const response = await route.POST(new Request("http://localhost/api/work-orders/w1/evidence-attachments", { method: "POST", body: form }), params("w1"));
  expect(response.status).toBe(200);
  const body = await response.json() as { saved: Array<{ uri: string; fileName: string; mediaType: string }> };
  expect(body.saved).toHaveLength(1);
  expect(body.saved[0]).toMatchObject({ fileName: "note.txt", mediaType: "text/plain" });
  expect(body.saved[0]!.uri).toContain(".crossline-evidence");
  expect(body.saved[0]!.uri).toContain("w1");
});

test("POST refuses an unsupported media type", async () => {
  seedActive();
  const route = await import("./route");
  const form = new FormData();
  form.append("file", new File(["x"], "a.exe", { type: "application/x-executable" }));
  const response = await route.POST(new Request("http://localhost/api/work-orders/w1/evidence-attachments", { method: "POST", body: form }), params("w1"));
  expect(response.status).toBe(400);
});
