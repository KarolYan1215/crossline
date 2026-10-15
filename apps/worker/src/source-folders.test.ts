import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SOURCE_FOLDERS_SETTING, folderPathProblem, readSourceFolders } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { addFolder, folderDocuments, previewFolder, removeFolder, scanFolder, setFolderLines, syncFolder } from "./source-folders";
import { createFolderClassifier } from "./folder-classifier";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let workspaceId: string;
let root: string;
let data: string;
const extracted: string[] = [];
const deps = () => ({ dataDir: data, home: path.join(root, "home"), extract: async (ws: string, id: string) => {
  extracted.push(id);
  const doc = store.listSourceDocuments(ws).find((item) => item.id === id)!;
  store.setSourceDocumentExtraction(ws, id, { status: "done", text: `text of ${doc.fileName}` });
} });
const put = (relative: string, content: string | Buffer) => { const full = path.join(root, "course", relative); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, content); return full; };

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人 workspace").workspace.id;
  root = mkdtempSync(path.join(tmpdir(), "crossline-folders-"));
  data = path.join(root, "data");
  extracted.length = 0;
  put("syllabus.md", "# ECE 548 syllabus");
  put("week1/notes.txt", "lecture 1");
  put("week1/slides.pptx", "pptx bytes");
  put("photo.jpg", "jpg");
  put(".env", "SECRET=1");
  put("node_modules/pkg/readme.md", "dependency");
  put(".git/config", "git");
  put("build/out.txt", "build output");
  put("~$draft.docx", "word lock file");
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

test("walking a folder reads documents and text, names slides, and leaves secrets, dependencies, build output and pictures alone", async () => {
  const scan = await scanFolder(path.join(root, "course"));
  const actions = Object.fromEntries(scan.files.map((file) => [file.relative.replace(/\\/g, "/"), file.action.action]));
  expect(actions).toEqual({ "syllabus.md": "read", "week1/notes.txt": "read", "week1/slides.pptx": "name_only" });
  expect(scan).toMatchObject({ read: 2, nameOnly: 1, skippedDirectories: 3 });
});

test("a drive, the user folder, system folders and the app's own data are refused before anything is walked", async () => {
  expect(folderPathProblem("C:\\")).toContain("整个磁盘");
  expect(folderPathProblem("C:\\Users\\ann", { home: "C:\\Users\\ann" })).toContain("用户文件夹");
  expect(folderPathProblem("C:\\Windows\\System32")).toContain("系统");
  expect(folderPathProblem("C:\\Users\\ann\\AppData\\Local\\Crossline")).toBeDefined();
  expect(folderPathProblem("relative\\path")).toContain("完整路径");
  expect(folderPathProblem("D:\\课程资料")).toBeUndefined();
  expect(await previewFolder(path.join(root, "missing"), deps())).toMatchObject({ state: "blocked", message: "找不到这个文件夹" });
  expect(await previewFolder(data, { ...deps(), dataDir: data })).toMatchObject({ state: "blocked" });
});

test("the preview says what would be read; adding reads it, and later passes read only what is new or changed", async () => {
  expect(await previewFolder(path.join(root, "course"), deps())).toMatchObject({ state: "preview", label: "course", files: 2, nameOnly: 1 });
  const added = await addFolder(store, workspaceId, path.join(root, "course"), deps());
  if (added.state !== "added") throw new Error("not added");
  expect(await syncFolder(store, workspaceId, added.folder, deps())).toEqual({ read: 3, waiting: 0 });
  const docs = store.listSourceDocuments(workspaceId);
  expect(docs.map((doc) => [doc.fileName, doc.extractionStatus]).sort()).toEqual([
    ["course/syllabus.md", "done"], ["course/week1/notes.txt", "done"], ["course/week1/slides.pptx", "unsupported"]]);
  expect(extracted).toHaveLength(2);
  // Nothing changed: nothing is read again.
  expect(await syncFolder(store, workspaceId, added.folder, deps())).toEqual({ read: 0, waiting: 0 });
  // One file edited, one added.
  const edited = put("week1/notes.txt", "lecture 1, revised");
  utimesSync(edited, new Date(), new Date(Date.now() + 5000));
  put("week2/notes.md", "lecture 2");
  expect(await syncFolder(store, workspaceId, added.folder, deps())).toEqual({ read: 2, waiting: 0 });
  expect(folderDocuments(store, workspaceId).size).toBe(4);
  expect(readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING))[0]).toMatchObject({ files: 3, nameOnly: 1 });
  // Revoked: the folder is no longer read, what was read stays.
  expect(removeFolder(store, workspaceId, added.folder.id)).toBe(true);
  expect(readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING))).toEqual([]);
  expect(store.listSourceDocuments(workspaceId).length).toBeGreaterThanOrEqual(4);
});

test("the model proposes a folder's lines once; the person's own choice is never replaced", async () => {
  store.setSetting(workspaceId, "lines.v1", JSON.stringify([{ id: "research", label: "研究者", color: "research", goal: "", goals: [], createdAt: "2026-10-14" },
    { id: "media", label: "创作者", color: "media", goal: "", goals: [], createdAt: "2026-10-14" }]));
  const added = await addFolder(store, workspaceId, path.join(root, "course"), deps());
  if (added.state !== "added") throw new Error("not added");
  await syncFolder(store, workspaceId, added.folder, deps());
  const answer = JSON.stringify({ folders: [{ id: added.folder.id, lineIds: ["research", "nonexistent"], why: "文件名多为 ECE 548 课件" }] });
  const { rpc } = fakeRuntime([answer], "crossline:crossline-folder-classifier");
  expect(await createFolderClassifier(store, workspaceId, "C:\\repo", () => rpc)()).toEqual({ filed: 1 });
  expect(readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING))[0]).toMatchObject({ lines: ["research"], linesBy: "model", linesWhy: "文件名多为 ECE 548 课件" });
  // Asked once: a folder already proposed for is not asked about again.
  expect(await createFolderClassifier(store, workspaceId, "C:\\repo", () => rpc)()).toEqual({ filed: 0 });
  expect(setFolderLines(store, workspaceId, added.folder.id, ["media", "research"])).toBe(true);
  expect(readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING))[0]).toMatchObject({ lines: ["media", "research"], linesBy: "person" });
});
