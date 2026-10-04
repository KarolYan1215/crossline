import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "./index";

let store: CrosslineStore;
const A = "workspace-a";
const B = "workspace-b";
const now = "2026-10-02T12:00:00.000Z";

beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

const project = (workspaceId: string, id: string, name: string, identityId = "research") =>
  ({ id, ownerId: "o", workspaceId, identityId, name, status: "active" as const, summary: "", createdAt: now, updatedAt: now });

test("one identity can have several projects, and archiving hides one without deleting it", () => {
  store.saveProject(project(A, "westlake", "西湖合作：MoS2 忆阻器片上训练"));
  store.saveProject(project(A, "replay", "hippocampus sleep replay 硬件实现"));
  expect(store.listProjects(A, { identityId: "research" }).map((p) => p.name)).toHaveLength(2);
  store.saveProject({ ...project(A, "replay", "hippocampus sleep replay 硬件实现"), status: "archived", updatedAt: now });
  expect(store.listProjects(A).map((p) => p.id)).toEqual(["westlake"]);
  expect(store.listProjects(A, { includeArchived: true }).map((p) => p.id)).toEqual(["westlake", "replay"]);
});

test("projects, documents, facts and sessions are scoped to their workspace", () => {
  store.saveProject(project(A, "p", "A 的项目"));
  store.saveProject(project(B, "p", "B 的项目"));
  expect(store.listProjects(A).map((p) => p.name)).toEqual(["A 的项目"]);
  expect(store.listProjects(B).map((p) => p.name)).toEqual(["B 的项目"]);

  store.upsertProfileFact({ workspaceId: A, identityId: "research", projectId: "p", slot: "deadline", value: "10/31",
    status: "confirmed", sourceRef: "reply-1", sourceQuote: "10/31 前投出", updatedAt: now });
  expect(store.listProfileFacts(B)).toEqual([]);

  store.saveOnboardingSession({ id: "s", ownerId: "o", workspaceId: A, state: "active", coverage: {}, createdAt: now, updatedAt: now });
  expect(store.getOnboardingSession(B, "s")).toBeUndefined();
  expect(store.getLatestOnboardingSession(B)).toBeUndefined();
});

test("the same file dropped twice is one document, and the second save returns the first", () => {
  const doc = (id: string) => ({ id, ownerId: "o", workspaceId: A, kind: "pdf" as const, fileName: "syllabus.pdf",
    mediaType: "application/pdf", sha256: "abc", uri: "file:///x", extractedText: "", extractionStatus: "pending" as const, createdAt: now });
  const first = store.saveSourceDocument(doc("d1"));
  const second = store.saveSourceDocument(doc("d2"));
  expect(second.id).toBe(first.id);
  expect(store.listSourceDocuments(A)).toHaveLength(1);
  // The same bytes in another workspace are that workspace's own document.
  expect(store.saveSourceDocument({ ...doc("d3"), workspaceId: B }).workspaceId).toBe(B);
});

test("extraction is recorded after upload and a document can be assigned to a project", () => {
  const saved = store.saveSourceDocument({ id: "d", ownerId: "o", workspaceId: A, kind: "docx", fileName: "plan.docx",
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sha256: "h", uri: "file:///y",
    extractedText: "", extractionStatus: "pending", createdAt: now });
  store.setSourceDocumentExtraction(A, saved.id, { status: "done", text: "Week-1: 8th Sept" });
  store.assignSourceDocumentProject(A, saved.id, "course-548");
  const [doc] = store.listSourceDocuments(A, { projectId: "course-548" });
  expect(doc).toMatchObject({ extractionStatus: "done", extractedText: "Week-1: 8th Sept", projectId: "course-548" });
});

test("onboarding messages keep their order and survive a reload of the session", () => {
  store.saveOnboardingSession({ id: "s", ownerId: "o", workspaceId: A, codexThreadId: "t-1", state: "active", coverage: { research: 2 }, createdAt: now, updatedAt: now });
  expect(store.appendOnboardingMessage({ sessionId: "s", workspaceId: A, role: "assistant", content: { questions: ["q"] }, createdAt: now })).toBe(1);
  expect(store.appendOnboardingMessage({ sessionId: "s", workspaceId: A, role: "user", content: { text: "a" }, createdAt: now })).toBe(2);
  expect(store.listOnboardingMessages(A, "s").map((m) => [m.seq, m.role])).toEqual([[1, "assistant"], [2, "user"]]);
  expect(store.getLatestOnboardingSession(A)).toMatchObject({ id: "s", codexThreadId: "t-1", coverage: { research: 2 } });
});

test("a confirmed fact is not overwritten by a later guess, but a later confirmation replaces it", () => {
  const fact = (value: string, status: "confirmed" | "inferred", ref: string) => ({ workspaceId: A, identityId: "startup", projectId: "",
    slot: "trial_users", value, status, sourceRef: ref, sourceQuote: value, updatedAt: now });
  store.upsertProfileFact(fact("10–30 人", "confirmed", "reply-3"));
  store.upsertProfileFact(fact("5 人", "inferred", "reply-9"));
  expect(store.listProfileFacts(A)[0]).toMatchObject({ value: "10–30 人", status: "confirmed", sourceRef: "reply-3" });
  store.upsertProfileFact(fact("20 人", "confirmed", "reply-12"));
  expect(store.listProfileFacts(A)[0]).toMatchObject({ value: "20 人", status: "confirmed", sourceRef: "reply-12" });
});

test("a guess can be replaced by a better guess, and then by a confirmation", () => {
  const fact = (value: string, status: "confirmed" | "inferred") => ({ workspaceId: A, identityId: "media", projectId: "",
    slot: "positioning", value, status, sourceRef: "r", sourceQuote: "", updatedAt: now });
  store.upsertProfileFact(fact("科研科普", "inferred"));
  store.upsertProfileFact(fact("科研过程记录", "inferred"));
  expect(store.listProfileFacts(A)[0]?.value).toBe("科研过程记录");
  store.upsertProfileFact(fact("科研 + 创业 build in public", "confirmed"));
  expect(store.listProfileFacts(A)[0]).toMatchObject({ value: "科研 + 创业 build in public", status: "confirmed" });
});

test("diligence reports round-trip their structured parts, newest first", () => {
  const base = { ownerId: "o", workspaceId: A, scope: "startup", question: "适合的比赛与孵化器？" };
  store.saveDiligenceReport({ ...base, id: "r1", findings: [{ title: "x" }], proposals: [], sources: [{ url: "https://example.com" }], status: "done", runAt: "2026-10-01T00:00:00.000Z" });
  store.saveDiligenceReport({ ...base, id: "r2", findings: [], proposals: [{ title: "申请" }], sources: [], status: "queued", runAt: "2026-10-02T00:00:00.000Z" });
  const reports = store.listDiligenceReports(A);
  expect(reports.map((r) => r.id)).toEqual(["r2", "r1"]);
  expect(reports[1]).toMatchObject({ findings: [{ title: "x" }], sources: [{ url: "https://example.com" }] });
});

test("the new tables are part of a snapshot and restore into an empty workspace", () => {
  store.saveProject(project(A, "p", "项目"));
  store.upsertProfileFact({ workspaceId: A, identityId: "research", projectId: "p", slot: "stage", value: "读文献", status: "confirmed", sourceRef: "r", sourceQuote: "", updatedAt: now });
  const snapshot = store.exportSnapshot(A);
  expect(Object.keys(snapshot.tables)).toEqual(expect.arrayContaining(["workspace_projects", "profile_facts", "source_documents", "onboarding_sessions", "onboarding_messages", "diligence_reports"]));
  const restored = new CrosslineStore(":memory:");
  try {
    restored.importSnapshot(snapshot);
    expect(restored.listProjects(A).map((p) => p.name)).toEqual(["项目"]);
    expect(restored.listProfileFacts(A)[0]?.value).toBe("读文献");
  } finally { restored.close(); }
});
