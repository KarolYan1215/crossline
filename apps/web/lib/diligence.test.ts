import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const { decideDiligenceProposal, loadDiligence } = await import("./diligence");
const { TEST_CTX } = await import("./test-support");

beforeEach(() => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  globalThis.crosslineStore.saveDiligenceReport({ id: "r1", ownerId: "o", workspaceId: TEST_CTX.workspaceId, scope: "startup", question: "q", status: "done",
    runAt: "2026-10-02T00:00:00.000Z", findings: [], sources: [{ id: "s1", title: "T", publisher: "P", url: "https://example.edu/a", accessedOn: "2026-10-02" }],
    proposals: [{ id: "p1", title: "x", why: "y", kind: "task", dueDate: "", findingIds: [], status: "pending" }] });
});
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("an answer to a proposal is recorded, can be changed, and leaves the rest of the report alone", () => {
  expect(decideDiligenceProposal(TEST_CTX, "r1", "p1", "accepted")).toEqual({ ok: true, captured: true });
  expect(loadDiligence(TEST_CTX)[0]?.proposals[0]?.status).toBe("accepted");
  expect(decideDiligenceProposal(TEST_CTX, "r1", "p1", "pending")).toEqual({ ok: true, captured: false });
  expect(loadDiligence(TEST_CTX)[0]).toMatchObject({ status: "done", proposals: [{ status: "pending" }], sources: [{ finalUrl: "https://example.edu/a" }] });
});

test("an unknown report or proposal is refused", () => {
  expect(decideDiligenceProposal(TEST_CTX, "nope", "p1", "accepted")).toEqual({ ok: false, code: "DILIGENCE_PROPOSAL_NOT_FOUND" });
  expect(decideDiligenceProposal(TEST_CTX, "r1", "nope", "accepted")).toEqual({ ok: false, code: "DILIGENCE_PROPOSAL_NOT_FOUND" });
});

test("another workspace's reports are never visible or decidable", () => {
  const other = { ...TEST_CTX, workspaceId: "someone-else" };
  expect(loadDiligence(other)).toEqual([]);
  expect(decideDiligenceProposal(other, "r1", "p1", "accepted")).toEqual({ ok: false, code: "DILIGENCE_PROPOSAL_NOT_FOUND" });
});

test("accepting a task writes it down once as a capture, so it is analysed into a task", () => {
  decideDiligenceProposal(TEST_CTX, "r1", "p1", "accepted");
  decideDiligenceProposal(TEST_CTX, "r1", "p1", "pending");
  expect(decideDiligenceProposal(TEST_CTX, "r1", "p1", "accepted")).toEqual({ ok: true, captured: false });
  const captures = globalThis.crosslineStore!.listCaptures(TEST_CTX.workspaceId);
  expect(captures).toHaveLength(1);
  expect(captures[0]).toMatchObject({ id: "diligence-r1-p1", title: "x" });
  expect(captures[0]?.context).toContain("来自调研建议");
});

test("the page shows what was looked for, not the researcher's rules", async () => {
  const { questionShown } = await import("./diligence");
  expect(questionShown("找出适合这个人当前阶段和身份约束的外部机会（比赛、孵化器、资助、合作渠道）。只列这个人按 facts 里的身份……不要假设这个人是学生。"))
    .toBe("找出适合本人当前阶段和身份约束的外部机会（比赛、孵化器、资助、合作渠道）。");
});
