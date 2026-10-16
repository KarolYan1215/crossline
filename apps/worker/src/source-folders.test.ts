import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SOURCE_FOLDERS_SETTING, folderPathProblem, readSourceFolders } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { fileURLToPath } from "node:url";
import { addFolder, folderDocuments, previewFolder, removeFolder, scanFolder, setFolderLines, setFolderRules, syncFolder } from "./source-folders";
import { createFolderClassifier } from "./folder-classifier";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let workspaceId: string;
let root: string;
let data: string;
const extracted: string[] = [];
// Stands in for the worker's `extractText`: a file's text is its bytes, as for a text file.
const deps = () => ({ dataDir: data, home: path.join(root, "home"), readText: async (bytes: Uint8Array) => {
  const text = Buffer.from(bytes).toString("utf8");
  extracted.push(text);
  return { status: "done" as const, text };
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
  expect(await syncFolder(store, workspaceId, added.folder, deps())).toEqual({ read: 3, waiting: 0, removed: 0 });
  const docs = store.listSourceDocuments(workspaceId);
  expect(docs.map((doc) => [doc.fileName, doc.extractionStatus]).sort()).toEqual([
    ["course/syllabus.md", "done"], ["course/week1/notes.txt", "done"], ["course/week1/slides.pptx", "unsupported"]]);
  expect(extracted).toHaveLength(2);
  // Nothing changed: nothing is read again.
  expect(await syncFolder(store, workspaceId, added.folder, deps())).toEqual({ read: 0, waiting: 0, removed: 0 });
  // One file edited, one added.
  const edited = put("week1/notes.txt", "lecture 1, revised");
  utimesSync(edited, new Date(), new Date(Date.now() + 5000));
  put("week2/notes.md", "lecture 2");
  expect(await syncFolder(store, workspaceId, added.folder, deps())).toEqual({ read: 2, waiting: 0, removed: 0 });
  expect(folderDocuments(store, workspaceId).size).toBe(4);
  expect(readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING))[0]).toMatchObject({ files: 3, nameOnly: 1 });
  // Revoked: the folder is no longer read, what was read stays.
  expect(removeFolder(store, workspaceId, added.folder.id)).toEqual({ removed: true, purged: 0 });
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

const events = (type: string) => store.listEvents(workspaceId, { type });
const addCourse = async (rules?: { exclude?: string[]; include?: string[]; names?: string[] }) => {
  const added = await addFolder(store, workspaceId, path.join(root, "course"), deps(), rules);
  if (added.state !== "added") throw new Error("not added");
  return added.folder;
};
const names = () => store.listSourceDocuments(workspaceId).map((doc) => doc.fileName).sort();

test("private papers are left out by name, shown apart in the preview, and read only once ticked back", async () => {
  put("Affidavit of Financial Support_UW Madison_2019.pdf", "affidavit");
  put("forms/Apply for a Social Security Card.pdf", "ssa");
  put("forms/notes.txt", "SSN on file: 123-45-6789");
  const preview = await previewFolder(path.join(root, "course"), deps());
  if (preview.state !== "preview") throw new Error("no preview");
  expect(preview.sensitive.map((file) => [file.relative, file.reason]).sort()).toEqual([
    ["Affidavit of Financial Support_UW Madison_2019.pdf", "资金证明"], ["forms/Apply for a Social Security Card.pdf", "社安号"], ["forms/notes.txt", "内容含社安号"]]);
  expect(preview.groups.map((group) => [group.name, group.files])).toEqual([["", 1], ["week1", 1]]);
  const folder = await addCourse();
  await syncFolder(store, workspaceId, folder, deps());
  expect(names()).toEqual(["course/syllabus.md", "course/week1/notes.txt", "course/week1/slides.pptx"]);
  // The text file's ID is found when it is read: nothing of it is kept, and the card lists it.
  expect(extracted.some((text) => text.includes("123-45-6789"))).toBe(true);
  const saved = readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING))[0]!;
  expect(saved.autoExcluded?.filter((file) => !file.hard).map((file) => file.relative).sort()).toEqual(["Affidavit of Financial Support_UW Madison_2019.pdf", "forms/Apply for a Social Security Card.pdf", "forms/notes.txt"]);
  // Ticked back: read now; taken back again: removed again.
  expect(await setFolderRules(store, workspaceId, folder.id, { exclude: [], include: ["forms/notes.txt", "Affidavit of Financial Support_UW Madison_2019.pdf"] }, deps()))
    .toMatchObject({ saved: true, read: 2, removed: 0 });
  expect(names()).toContain("course/forms/notes.txt");
  expect(await setFolderRules(store, workspaceId, folder.id, { exclude: [], include: [] }, deps())).toMatchObject({ removed: 2 });
  expect(names()).not.toContain("course/forms/notes.txt");
  expect(names()).not.toContain("course/Affidavit of Financial Support_UW Madison_2019.pdf");
});

test("excluding what was read removes it from sources and its stored copy, keeps an upload with the same content, and is recorded", async () => {
  put("old/a.md", "same as the upload");
  put("old/b.md", "only here");
  const upload = store.saveSourceDocument({ id: "upload-1", ownerId: "user-1", workspaceId, kind: "text", fileName: "a.md", mediaType: "text/plain",
    sha256: createHash("sha256").update("same as the upload").digest("hex"), uri: "file:///nowhere", extractedText: "x", extractionStatus: "done", createdAt: "2026-10-15" });
  const folder = await addCourse({ exclude: ["week1"] });
  await syncFolder(store, workspaceId, folder, deps());
  expect(names()).toEqual(["a.md", "course/old/b.md", "course/syllabus.md"]);
  const copy = fileURLToPath(store.listSourceDocuments(workspaceId).find((doc) => doc.fileName === "course/old/b.md")!.uri);
  expect(existsSync(copy)).toBe(true);
  expect(await setFolderRules(store, workspaceId, folder.id, { exclude: ["week1", "old"], include: [] }, deps())).toMatchObject({ saved: true, removed: 1 });
  expect(names()).toEqual(["a.md", "course/syllabus.md"]);
  expect(store.listSourceDocuments(workspaceId).find((doc) => doc.id === upload.id)).toBeDefined();
  expect(existsSync(copy)).toBe(false);
  expect(events("sources.folder_content_removed").map((event) => event.payload)).toEqual([{ folderId: folder.id, label: "course", removed: 1, reason: "excluded" }]);
  // Rescans obey the rules: nothing under `old` comes back.
  await syncFolder(store, workspaceId, folder, deps());
  expect(names()).toEqual(["a.md", "course/syllabus.md"]);
});

test("copies of one content are read once and named in the preview", async () => {
  put("开题报告.doc.md", "proposal");
  put("开题报告 (1).doc.md", "proposal");
  put("开题报告 (2).doc.md", "proposal");
  const preview = await previewFolder(path.join(root, "course"), deps());
  if (preview.state !== "preview") throw new Error("no preview");
  expect(preview.duplicates).toBe(2);
  expect(preview.groups.find((group) => group.name === "")!.list.find((file) => file.relative === "开题报告.doc.md")).toMatchObject({ duplicates: 2 });
  const folder = await addCourse();
  await syncFolder(store, workspaceId, folder, deps());
  expect(names().filter((name) => name.includes("开题报告"))).toEqual(["course/开题报告.doc.md"]);
  expect(readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING))[0]).toMatchObject({ duplicates: 2 });
});

test("past the limit the most recently changed files are read, and the rest are counted", async () => {
  for (let index = 0; index < 1002; index += 1) {
    const file = put(`bulk/n${index}.txt`, `note ${index}`);
    const at = new Date(Date.UTC(2026, 0, 1) + index * 60_000);
    utimesSync(file, at, at);
  }
  const scan = await scanFolder(path.join(root, "course"));
  expect(scan.over).toBe(4); // 1002 + syllabus + notes, 1000 read
  expect(scan.files.filter((file) => file.capped).map((file) => file.relative.replace(/\\/g, "/")).sort()).toEqual(["bulk/n0.txt", "bulk/n1.txt", "bulk/n2.txt", "bulk/n3.txt"]);
  // Leaving the subfolder out brings it under the limit.
  expect((await scanFolder(path.join(root, "course"), { exclude: ["bulk"] })).over).toBe(0);
}, 60_000);  // writes 1002 real files: seconds under a loaded full run

test("revoking keeps what was read by default; purging deletes what this folder brought in, never an upload, and is recorded", async () => {
  put("shared.md", "uploaded too");
  store.saveSourceDocument({ id: "upload-1", ownerId: "user-1", workspaceId, kind: "text", fileName: "shared.md", mediaType: "text/plain",
    sha256: createHash("sha256").update("uploaded too").digest("hex"), uri: "file:///nowhere", extractedText: "x", extractionStatus: "done", createdAt: "2026-10-15" });
  const folder = await addCourse();
  await syncFolder(store, workspaceId, folder, deps());
  expect(names()).toHaveLength(4);
  expect(removeFolder(store, workspaceId, folder.id, { purge: true, dataDir: data })).toEqual({ removed: true, purged: 3 });
  expect(names()).toEqual(["shared.md"]);
  expect(events("sources.folder_revoked").map((event) => event.payload)).toEqual([{ folderId: folder.id, label: "course", purged: 3 }]);
  expect(events("sources.folder_content_removed").map((event) => event.payload)).toEqual([{ folderId: folder.id, label: "course", removed: 3, reason: "revoked" }]);
});

test("credentials are never read, whatever the page asks: by name, by extension, and by a key in the text", async () => {
  put("AccessKey.txt", "id,secret");
  put("默认业务空间-apiKey-5728154.csv", "name,key");
  put("server.pem", "cert");
  put("notes/deploy.md", "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx");
  put("notes/ok.md", "lecture notes");
  const preview = await previewFolder(path.join(root, "course"), deps());
  if (preview.state !== "preview") throw new Error("no preview");
  expect(preview.credentials.map((file) => [file.relative, file.reason]).sort()).toEqual([
    [".env", "凭据"], ["AccessKey.txt", "凭据"], ["notes/deploy.md", "内容含凭据"], ["server.pem", "凭据"], ["默认业务空间-apiKey-5728154.csv", "凭据"]]);
  expect(preview.sensitive).toEqual([]);
  // Ticked back in a forged request: still not read.
  const folder = await addCourse({ include: ["AccessKey.txt", "默认业务空间-apiKey-5728154.csv", "notes/deploy.md"] });
  await syncFolder(store, workspaceId, folder, deps());
  expect(names()).toEqual(["course/notes/ok.md", "course/syllabus.md", "course/week1/notes.txt", "course/week1/slides.pptx"]);
  const saved = readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING))[0]!;
  expect(saved.autoExcluded?.filter((file) => file.hard).map((file) => file.relative).sort()).toEqual([
    ".env", "AccessKey.txt", "notes/deploy.md", "server.pem", "默认业务空间-apiKey-5728154.csv"]);
  // The key was found in the text when it was read: nothing kept, and the index remembers it so it is not read again.
  const index = JSON.parse(store.getSetting(workspaceId, `sources.folder.index:${folder.id}`)!) as Record<string, unknown>;
  expect(Object.entries(index).find(([relative]) => relative.endsWith("deploy.md"))?.[1]).toMatchObject({ documentId: "", hard: true });
});

test("a record carrying the person's name beside a student number is left out, with the account's name or without it", async () => {
  put("20260129190544158678_颜开2254009毕业论文开题报告.doc.md", "proposal");
  put("Kai Yan 2254009 transcript.md", "grades");
  const plain = await previewFolder(path.join(root, "course"), deps());
  const named = await previewFolder(path.join(root, "course"), deps(), ["Kai Yan"]);
  if (plain.state !== "preview" || named.state !== "preview") throw new Error("no preview");
  expect(plain.sensitive.map((file) => file.relative)).toEqual(["20260129190544158678_颜开2254009毕业论文开题报告.doc.md"]);
  expect(named.sensitive.map((file) => [file.relative, file.reason]).sort()).toEqual([
    ["20260129190544158678_颜开2254009毕业论文开题报告.doc.md", "个人档案"], ["Kai Yan 2254009 transcript.md", "个人档案"]]);
  // The names given when authorizing are kept, so later passes obey them.
  const folder = await addCourse({ names: ["Kai Yan"] });
  expect(folder.names).toEqual(["Kai Yan"]);
  await syncFolder(store, workspaceId, folder, deps());
  expect(names().some((name) => name.includes("2254009"))).toBe(false);
});
