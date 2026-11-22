import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SOURCE_VERSIONS_SETTING, readSourceVersions } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { createVersionJudge, supersededDocumentIds, VERSION_NOTE_ID } from "./source-versions";
import { transcriptDocumentIds } from "./recording-digest";
import { createFolderScreener } from "./folder-classifier";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let workspaceId: string;
let data: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "w").workspace.id;
  data = mkdtempSync(path.join(tmpdir(), "crossline-versions-"));
});
afterEach(() => { store.close(); rmSync(data, { recursive: true, force: true }); });

const body = "Kai 的研究计划：第一部分讲背景与动机，第二部分讲方法，第三部分讲时间表与里程碑，每月一次组会汇报。".repeat(12);
const save = (id: string, fileName: string, text: string, createdAt: string) => store.saveSourceDocument({ id, ownerId: "user-1", workspaceId, kind: "text", fileName,
  mediaType: "text/plain", sha256: id, uri: `file:///${id}`, extractedText: text, extractionStatus: "done", createdAt });

test("code circles near-duplicates, the model confirms the versions and picks the latest; the older one is read through a note", async () => {
  save("old", "研究计划.md", body, "2026-03-01T00:00:00Z");
  save("new", "研究计划-终稿.md", `${body}新增：第四部分讲风险。`, "2026-04-01T00:00:00Z");
  save("other", "购物清单.md", "牛奶、鸡蛋、面包、苹果、香蕉、米、面、油、盐、酱、醋、茶。".repeat(20), "2026-04-02T00:00:00Z");
  const answer = JSON.stringify({ pairs: [{ a: "new", b: "old", sameDocument: true, latestId: "new", olderSummary: "较早的研究计划，有背景、方法和时间表三部分。",
    differences: "终稿新增第四部分「风险」。", why: "文件名标为终稿且内容是扩展" }] });
  const { rpc } = fakeRuntime([answer], "crossline:crossline-source-digest");
  expect(await createVersionJudge(store, workspaceId, "C:\\repo", () => rpc, { dataDir: data })()).toEqual({ asked: 1, superseded: 1 });
  expect([...supersededDocumentIds(store, workspaceId)]).toEqual(["old"]);
  // The interview skips the older file in full and reads its note; the original stays stored.
  expect(transcriptDocumentIds(store, workspaceId).has("old")).toBe(true);
  const note = store.listSourceDocuments(workspaceId).find((doc) => doc.id === `${VERSION_NOTE_ID}old`)!;
  expect(note.extractedText).toContain("终稿新增第四部分「风险」");
  expect(note.extractedText).toContain("read_file");
  expect(store.listSourceDocuments(workspaceId).some((doc) => doc.id === "old")).toBe(true);
  // Asked once: the same pair is not put to the model again.
  expect(await createVersionJudge(store, workspaceId, "C:\\repo", () => rpc, { dataDir: data })()).toEqual({ asked: 0, superseded: 0 });
  expect(readSourceVersions(store.getSetting(workspaceId, SOURCE_VERSIONS_SETTING)).checked).toEqual(["new|old"]);
});

test("two different documents that only look alike stay as they are", async () => {
  save("a", "第一周报告.md", body, "2026-03-01T00:00:00Z");
  save("b", "第二周报告.md", `${body}本周另有安排。`, "2026-03-08T00:00:00Z");
  const answer = JSON.stringify({ pairs: [{ a: "a", b: "b", sameDocument: false, latestId: "", olderSummary: "", differences: "", why: "两周各自的报告" }] });
  const { rpc } = fakeRuntime([answer], "crossline:crossline-source-digest");
  expect(await createVersionJudge(store, workspaceId, "C:\\repo", () => rpc, { dataDir: data })()).toEqual({ asked: 1, superseded: 0 });
  expect(supersededDocumentIds(store, workspaceId).size).toBe(0);
});

test("a picked folder is screened by the model by name, size and date, within the limit", async () => {
  const files = [{ path: "docs/plan.md", size: 2000, modified: Date.UTC(2026, 3, 1) }, { path: "docs/LICENSE.txt", size: 1000, modified: Date.UTC(2020, 0, 1) },
    { path: "docs/cv.pdf", size: 90_000, modified: Date.UTC(2026, 2, 1) }];
  const { rpc } = fakeRuntime([JSON.stringify({ keep: [2, 0, 0, 9], why: "保留简历和计划，许可证不读" })], "crossline:crossline-folder-classifier");
  expect(await createFolderScreener(store, workspaceId, "C:\\repo", () => rpc)("docs", files, 60)).toEqual({ keep: ["docs/cv.pdf", "docs/plan.md"], why: "保留简历和计划，许可证不读" });
});
