import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { collectAsks } from "./asks";
import { interviewStatus, questionsOwnedElsewhere } from "./interview-status";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });
const ws = TEST_CTX.workspaceId;

function setup(nextAction: "ask" | "ready_for_milestones" = "ask") {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  for (const [id, name] of [["ece555", "ECE 555"], ["ece548", "ECE 548"]] as const)
    store.saveProject({ id, ownerId: "o", workspaceId: ws, identityId: "research", name, summary: "", status: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
  for (const [id, fileName, text] of [["a", "Course Overview.docx", "Fermi-Dirac Statistics"], ["b", "TENTATIVE_Lecture Plan for Fall 2026.docx", "Week-1"]] as const)
    store.saveSourceDocument({ id, ownerId: "o", workspaceId: ws, kind: "text", fileName, mediaType: "text/plain", sha256: id, uri: `file://${id}`,
      extractedText: text, extractionStatus: "done", createdAt: "2026-10-01T00:00:00Z" });
  store.saveOnboardingSession({ id: "s1", ownerId: "o", workspaceId: ws, state: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", coverage: { stage: "lines",
    coverage: [{ identityId: "research", filled: [], missing: ["ECE 548 固定课时", "组会时段"] }] } });
  const questions = [
    { id: "q-course-map", text: "两份半导体器件课程文件与 ECE 548 的关系？", kind: "single", allowOther: true, identityId: "research", projectId: "",
      options: [{ id: "both", label: "均属于 ECE 548", detail: "《Course Overview》和《TENTATIVE Lecture Plan》均为 ECE 548 材料。" }, { id: "no", label: "都不是", detail: "" }] },
    { id: "q-meetings", text: "组会和导师 1V1 的固定时间？", kind: "free", allowOther: true, identityId: "research", projectId: "", options: [] }];
  store.appendOnboardingMessage({ workspaceId: ws, sessionId: "s1", role: "assistant", createdAt: "2026-10-08T00:00:00Z",
    content: { reply: "…", questions, nextAction, stage: "lines" } });
  return { store, questions };
}

test("an interview question about which project a file belongs to is left to 待决事项, other questions stay", () => {
  const { questions } = setup();
  expect([...questionsOwnedElsewhere(TEST_CTX, questions)]).toEqual(["q-course-map"]);
  // …and both files it names are asked about there, the one that dated nothing included, so leaving the question out loses nothing.
  expect(collectAsks(TEST_CTX).filter((ask) => ask.kind === "source_project").map((ask) => ask.entityId).sort()).toEqual(["a", "b"]);
});

test("an interview is judged by its completion list, says where it stopped, and is listed once on 待决事项 with a way back", () => {
  setup();
  const status = interviewStatus(TEST_CTX);
  expect(status).toMatchObject({ started: true, complete: false, awaitingPerson: false, stage: "lines", stageIndex: 5, stageCount: 6, openQuestions: 1 });
  expect(status.checklist.find((item) => item.id === "portrait_fields")?.done).toBe(false);
  const ask = collectAsks(TEST_CTX).find((item) => item.kind === "interview_open")!;
  expect(ask.title).toMatch(/^访谈未完成：清单 \d+\/\d+$/);
  expect(ask.why).toContain("「主线」阶段（第 5/6 阶段）");
  expect(ask.why).toContain("画像各部分已写出");
  expect(ask.options[0]).toMatchObject({ label: "继续访谈", href: "/onboarding" });
});

test("the model saying it is ready does not finish the interview while the list is open", () => {
  setup("ready_for_milestones");
  expect(interviewStatus(TEST_CTX).complete).toBe(false);
  expect(interviewStatus(TEST_CTX).openQuestions).toBe(0);
  expect(collectAsks(TEST_CTX).some((item) => item.kind === "interview_open")).toBe(true);
});
