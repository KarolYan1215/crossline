import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import Database from "better-sqlite3";
import { CrosslineStore, type StoredSourceDocument } from "./index";

/**
 * The passage index (migration 19, docs/context-selection.md): a document's text cut into passages under 「文件名 · 项目 · 线」 in an FTS5
 * trigram table, kept current by the store whenever a file is read, re-read, filed or removed, and by triggers on the index itself.
 */
const WS = "w1";
const doc = (id: string, fileName: string, text: string, extra: Partial<StoredSourceDocument> = {}): StoredSourceDocument => ({
  id, ownerId: "o", workspaceId: WS, kind: "text", fileName, mediaType: "text/plain", sha256: `sha-${id}`, uri: `file:///${id}`,
  extractedText: text, extractionStatus: "done", createdAt: "2026-10-20T00:00:00.000Z", ...extra });
const now = "2026-10-20T00:00:00.000Z";
const project = (id: string, name: string, identityId = "research") =>
  ({ id, ownerId: "o", workspaceId: WS, identityId, name, status: "active" as const, summary: "", createdAt: now, updatedAt: now });
const ftsRows = (store: CrosslineStore) => {
  const raw = new Database(store.file, { readonly: true });
  try { return (raw.prepare("SELECT COUNT(*) AS n FROM doc_chunks_fts_docsize").get() as { n: number }).n; } finally { raw.close(); }
};
function withFile(work: (store: CrosslineStore, path: string) => void) {
  const path = `crossline-test-${randomUUID()}.db`;
  const store = new CrosslineStore(path);
  try { work(store, path); } finally {
    store.close();
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}.v18.bak`, `${path}.v0.bak`]) if (existsSync(file)) rmSync(file);
  }
}

test("a saved file is cut into passages and found by a three-character phrase, a Latin term or a two-character word", () => {
  const store = new CrosslineStore(":memory:");
  store.saveProject(project("ece548", "ECE 548"));
  const lectures = Array.from({ length: 12 }, (_, i) => `Lecture ${i + 1}: topic ${i + 1} on VLSI timing and power.`).join("\n");
  store.saveSourceDocument(doc("d1", "Lecture Plan.docx", `${lectures}\n\n${"x".repeat(900)}\n\nMidterm 1 covers lectures 1-6. 期中考试范围为前六讲。组会每周三。`, { projectId: "ece548" }));
  store.saveSourceDocument(doc("d2", "recipes.txt", "番茄炒蛋：先炒蛋再炒番茄。"));
  const hits = store.searchDocChunks(WS, "midterm 期中考试");
  expect(hits[0]).toMatchObject({ documentId: "d1", fileName: "Lecture Plan.docx", projectId: "ece548", identityId: "research" });
  expect(hits[0]!.heading).toBe("Lecture Plan.docx · ECE 548 · research");
  expect(store.searchDocChunks(WS, "组会").map((hit) => hit.documentId)).toEqual(["d1"]);
  // The heading is indexed: a query naming the course finds its file even where the passage itself does not say it.
  expect(store.searchDocChunks(WS, "ECE 548").every((hit) => hit.documentId === "d1")).toBe(true);
  expect(store.searchDocChunks(WS, "番茄")[0]!.documentId).toBe("d2");
  expect(store.searchDocChunks(WS, "量子引力")).toEqual([]);
  store.close();
});

test("re-reading, filing and removing a file, and renaming its project, keep the index current", () => withFile((store) => {
  store.saveProject(project("p1", "西湖 MoS2"));
  store.saveSourceDocument(doc("d1", "notes.md", "", { extractionStatus: "pending" }));
  expect(store.docChunkCounts(WS).get("d1")).toBeUndefined();
  store.setSourceDocumentExtraction(WS, "d1", { status: "done", text: "NeuroSim 仿真参数：器件电导范围与写入噪声。" });
  expect(store.searchDocChunks(WS, "NeuroSim")[0]!.heading).toBe("notes.md · 未归项目");
  store.assignSourceDocumentProject(WS, "d1", "p1");
  expect(store.searchDocChunks(WS, "NeuroSim")[0]).toMatchObject({ heading: "notes.md · 西湖 MoS2 · research", projectId: "p1" });
  store.saveProject({ ...project("p1", "单晶 MoS2 片上训练"), updatedAt: "2026-10-21T00:00:00.000Z" });
  expect(store.searchDocChunks(WS, "片上训练")[0]!.heading).toBe("notes.md · 单晶 MoS2 片上训练 · research");
  expect(store.searchDocChunks(WS, "西湖")).toEqual([]);
  store.setSourceDocumentExtraction(WS, "d1", { status: "done", text: "改写后的内容：写入噪声的测量方法。" });
  expect(store.searchDocChunks(WS, "NeuroSim")).toEqual([]);
  expect(store.searchDocChunks(WS, "测量方法")).toHaveLength(1);
  expect(ftsRows(store)).toBe(1);
  store.deleteSourceDocument(WS, "d1");
  expect(store.searchDocChunks(WS, "测量方法")).toEqual([]);
  expect(ftsRows(store)).toBe(0);
}));

test("a passage is read only within its workspace, with its neighbours named", () => {
  const store = new CrosslineStore(":memory:");
  store.saveSourceDocument(doc("d1", "long.txt", Array.from({ length: 90 }, (_, i) => `第${i + 1}节 内容段落，讲述电路时序分析的细节。`).join("\n")));
  store.saveSourceDocument({ ...doc("d9", "other.txt", "电路时序分析 another workspace"), workspaceId: "w2" });
  const [first] = store.documentChunks(WS, "d1", 1);
  expect(store.docChunkCounts(WS).get("d1")).toBeGreaterThan(1);
  const read = store.readDocChunk(WS, first!.id)!;
  expect(read).toMatchObject({ documentId: "d1", ord: 0, fileName: "long.txt" });
  expect(read.previousId).toBeUndefined();
  expect(read.nextId).toBeGreaterThan(0);
  expect(read.total).toBe(store.docChunkCounts(WS).get("d1"));
  const foreign = store.searchDocChunks("w2", "电路时序分析")[0]!;
  expect(store.readDocChunk(WS, foreign.id)).toBeUndefined();
  expect(store.searchDocChunks(WS, "电路时序分析").every((hit) => hit.documentId === "d1")).toBe(true);
  store.close();
});

test("migration 19 builds the index for the files an older database already holds", () => {
  const path = `crossline-test-${randomUUID()}.db`;
  try {
    const first = new CrosslineStore(path);
    first.saveSourceDocument(doc("d1", "syllabus.pdf", "Final project report due December 12. 期末项目报告。"));
    first.close();
    // Back to the shape before migration 19, with a raw connection.
    const legacy = new Database(path);
    legacy.exec(`DROP TRIGGER doc_chunks_ai; DROP TRIGGER doc_chunks_ad; DROP TRIGGER doc_chunks_au; DROP TABLE doc_chunks_fts; DROP TABLE doc_chunks;`);
    legacy.pragma("user_version = 18");
    legacy.close();
    const store = new CrosslineStore(path);
    try {
      expect(store.schemaVersion()).toBeGreaterThanOrEqual(19);
      expect(store.searchDocChunks(WS, "期末项目报告")[0]!.documentId).toBe("d1");
      expect(existsSync(`${path}.v18.bak`)).toBe(true);
    } finally { store.close(); }
  } finally {
    for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}.v18.bak`, `${path}.v0.bak`]) if (existsSync(file)) rmSync(file);
  }
});

test("the index is not exported, is rebuilt on restore, and goes with a reset or a purge", () => {
  const source = new CrosslineStore(":memory:");
  const { workspace } = source.createPrincipalWithWorkspace("auth-1", "ws");
  source.saveSourceDocument({ ...doc("d1", "brief.md", "小红书首轮选题：四类题材各一条。"), workspaceId: workspace.id });
  const snapshot = JSON.parse(JSON.stringify(source.exportSnapshot(workspace.id)));
  expect(Object.keys(snapshot.tables)).not.toContain("doc_chunks");
  expect(Object.keys(snapshot.tables).some((name) => name.startsWith("doc_chunks"))).toBe(false);
  expect(source.tableNames().some((name) => name.startsWith("doc_chunks"))).toBe(false);

  const restored = new CrosslineStore(":memory:");
  restored.importSnapshot(snapshot);
  expect(restored.searchDocChunks(workspace.id, "首轮选题")[0]!.documentId).toBe("d1");
  // A snapshot that carries the derived table anyway (an older export of this branch) is not refused: the passages are cut again.
  const carrying = new CrosslineStore(":memory:");
  carrying.importSnapshot({ ...snapshot, tables: { ...snapshot.tables, doc_chunks: [{ id: 99, workspace_id: workspace.id, document_id: "d1", ord: 0, start_at: 0, heading: "x", body: "stale" }] } });
  expect(carrying.searchDocChunks(workspace.id, "stale")).toEqual([]);
  expect(carrying.searchDocChunks(workspace.id, "首轮选题")).toHaveLength(1);

  restored.resetWorkspace(workspace.id, { settingPrefixes: [], eventTypePrefixes: [] });
  expect(restored.searchDocChunks(workspace.id, "首轮选题")).toEqual([]);
  expect(restored.docChunkCounts(workspace.id).size).toBe(0);
  source.purgeWorkspace(workspace.id);
  expect(source.searchDocChunks(workspace.id, "首轮选题")).toEqual([]);
  for (const store of [source, restored, carrying]) store.close();
});

test("purging one workspace leaves another workspace's passages searchable", () => withFile((store) => {
  store.saveSourceDocument(doc("d1", "a.txt", "共同的检索词组：电路时序分析"));
  store.saveSourceDocument({ ...doc("d2", "b.txt", "共同的检索词组：电路时序分析"), workspaceId: "w2", sha256: "other" });
  store.purgeWorkspace(WS);
  expect(store.searchDocChunks("w2", "电路时序分析")).toHaveLength(1);
  expect(ftsRows(store)).toBe(1);
}));
