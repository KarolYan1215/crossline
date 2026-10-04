import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const { listCourseTargets, setCourseTarget, countProposedTargets } = await import("./targets");
const { TEST_CTX } = await import("./test-support");

beforeEach(() => {
  const store = new CrosslineStore(":memory:");
  globalThis.crosslineStore = store;
  const at = "2026-10-02T00:00:00.000Z";
  store.saveProject({ id: "ece555", ownerId: "o", workspaceId: TEST_CTX.workspaceId, identityId: "research", name: "ECE 555", status: "active", summary: "", createdAt: at, updatedAt: at });
  store.upsertProfileFact({ workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "ece555", slot: "grading", value: "作业 20%、小测 30%", status: "confirmed", sourceRef: "src-1", sourceQuote: "作业 20%", updatedAt: at });
  store.upsertProfileFact({ workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "ece555", slot: "target_grade",
    value: "总评 A−（≥ 90）（暂定：这门课稳妥即可，时间留给论文）", status: "inferred", sourceRef: "inference", sourceQuote: "", updatedAt: at });
});
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("a proposed target shows its value and its reason apart, and counts as waiting", () => {
  expect(listCourseTargets(TEST_CTX)).toEqual([{ projectId: "ece555", identityId: "research", name: "ECE 555", value: "总评 A−（≥ 90）", why: "这门课稳妥即可，时间留给论文", proposed: true }]);
  expect(countProposedTargets(TEST_CTX)).toBe(1);
});

test("changing it makes it the person's own, and it no longer waits", () => {
  expect(setCourseTarget(TEST_CTX, { projectId: "ece555", value: "总评 A（≥ 93）" })).toEqual({ ok: true, identityId: "research" });
  expect(listCourseTargets(TEST_CTX)[0]).toMatchObject({ value: "总评 A（≥ 93）", why: "", proposed: false });
  expect(countProposedTargets(TEST_CTX)).toBe(0);
});

test("an unknown project or an empty target is refused", () => {
  expect(setCourseTarget(TEST_CTX, { projectId: "nope", value: "总评 A" })).toEqual({ ok: false, code: "PROJECT_UNKNOWN" });
  expect(setCourseTarget(TEST_CTX, { projectId: "ece555", value: " " })).toEqual({ ok: false, code: "TARGET_INVALID" });
});
