import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { CALENDAR_LINES, calendarLinesBasis } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { answerAsk, collectAsks } from "./asks";
import { identityLines } from "./lines";
import { loadTimeline } from "./timeline";
import { TEST_CTX } from "./test-support";
import { recentOps, undoOp } from "./undo";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });
const ws = TEST_CTX.workspaceId;
const NOW = new Date("2026-10-08T15:00:00.000Z");

function setup() {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  for (const [id, name] of [["ece555", "ECE 555"], ["ece548", "ECE 548"]] as const)
    store.saveProject({ id, ownerId: "o", workspaceId: ws, identityId: "research", name, summary: "", status: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
  const doc = (id: string, fileName: string, text: string) => store.saveSourceDocument({ id, ownerId: "o", workspaceId: ws, kind: "text", fileName, mediaType: "text/plain",
    sha256: id, uri: `file://${id}`, extractedText: text, extractionStatus: "done", createdAt: `2026-10-0${{ a: 1, b: 2, c: 3 }[id] ?? 4}T00:00:00Z` });
  doc("a", "F26-ECE555-Course Schedule.pdf", "12/7 Final Exam (in class)");
  doc("b", "TENTATIVE_Lecture Plan for Fall 2026.docx", "Week-8: 27th Oct. L15: Mid-term-1");
  doc("c", "profile.md", "ECE 555 与 ECE 548");
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "dates:1", type: "dates.extracted", entityId: "batch-1", payload: { documentIds: ["a", "b"],
    dates: [{ id: "final", title: "课堂期末考试", project: "ECE 555", sourceRef: "src-1", date: "2026-12-07" },
      { id: "mid", title: "期中考试 1", project: "课程待确认（可能为 ECE 548）", sourceRef: "src-2", date: "2026-10-27" },
      { id: "cv", title: "开始读博", project: "", sourceRef: "src-3", date: "2026-08-01" },
      { id: "cv2", title: "姓名与地点记录", project: "个人档案", sourceRef: "src-3", date: "2026-10-08" },
      { id: "cv3", title: "博士阶段定位", project: "研究者", sourceRef: "src-3", date: "2026-09-25" }], recurring: [], undated: [] } });
  return store;
}

test("a file nothing on record ties to a project is asked about once, with the interview's lean recommended; the answer names its dates", async () => {
  const store = setup();
  const asks = collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "source_project");
  // The ECE 555 schedule names its course in its file name: not asked. A CV's dates belong to no project: not asked. The lecture plan: asked.
  expect(asks.map((ask) => ask.entityId)).toEqual(["b"]);
  expect(asks[0]!.options.find((option) => option.recommended)?.label).toBe("ECE 548");
  expect(asks[0]!.why).toContain("「期中考试 1」");
  expect(asks[0]!.dueDay).toBe("2026-10-27");
  expect(await answerAsk(TEST_CTX, asks[0]!.id, "p:ece548", {}, NOW)).toMatchObject({ ok: true });
  expect(store.listSourceDocuments(ws).find((doc) => doc.id === "b")?.projectId).toBe("ece548");
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "source_project")).toBe(false);
  // Undone: the file is unfiled again and the question comes back.
  expect(undoOp(TEST_CTX, recentOps(TEST_CTX)[0]!.id)).toMatchObject({ ok: true });
  expect(store.listSourceDocuments(ws).find((doc) => doc.id === "b")?.projectId).toBeUndefined();
  expect(collectAsks(TEST_CTX, NOW).some((ask) => ask.kind === "source_project")).toBe(true);
});

test("a profile or CV is about the person, even when it names only one project in passing; a plain note still is asked about", () => {
  const store = setup();
  // As the real profile did: one project named only well past the opening, so nothing files it and it would be asked about.
  const text = `博士一年级，方向是神经形态计算。${"每周大约投入七十二小时。".repeat(160)}课程里有 ECE 548。`;
  const doc = (id: string, fileName: string) => store.saveSourceDocument({ id, ownerId: "o", workspaceId: ws, kind: "text", fileName, mediaType: "text/markdown",
    sha256: id, uri: `file://${id}`, extractedText: text, extractionStatus: "done", createdAt: "2026-10-05T00:00:00Z" });
  doc("p", "personal-profile.md");
  doc("r", "Resume 2026.pdf");
  doc("n", "notes.md");
  const asked = collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "source_project").map((ask) => ask.entityId);
  expect(asked).not.toContain("p");
  expect(asked).not.toContain("r");
  expect(asked).toContain("n");
});

test("a calendar event nothing places is asked about, and the person's answer colours it and survives a renamed line", async () => {
  const store = setup();
  const day = "2026-10-08";
  store.savePlanVersion({ id: "plan-1", ownerId: "o", workspaceId: ws, version: 1, status: "approved", payload: { blocks: [
    { id: "graph_calendar:x", lane: "human", title: "Hold", day, start: "10:00", end: "11:00", source: "日历", readOnly: true }] } });
  store.setSetting(ws, CALENDAR_LINES, JSON.stringify({ basis: calendarLinesBasis(identityLines(TEST_CTX)),
    entries: { hold: { lineId: "", why: "标题看不出", at: "2026-10-08T00:00:00Z", unclear: true, by: "model" } } }));
  const ask = collectAsks(TEST_CTX, NOW).find((item) => item.kind === "calendar_line_unclear")!;
  expect(ask.title).toContain("Hold");
  expect(await answerAsk(TEST_CTX, ask.id, "l:startup", {}, NOW)).toMatchObject({ ok: true });
  expect((await loadTimeline(TEST_CTX)).items.find((item) => item.title === "Hold")?.identityId).toBe("startup");
  expect(collectAsks(TEST_CTX, NOW).some((item) => item.kind === "calendar_line_unclear")).toBe(false);
});
