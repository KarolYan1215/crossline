import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { PDK_TERMS_SETTING, SOURCE_FOLDERS_SETTING, readSourceFolders } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { addFolder, folderDocuments, listFolderEntries, readFolderFile, syncFolder } from "./source-folders";
import { readDeviceState, sourceItems } from "./device/payloads";

/**
 * 「仅本地」 and PDK terms (docs/plans/execution-gates-1124.md 四.0, 2026-11-24): a folder marked local only, or a file whose path hits a
 * PDK term, is never opened; only a masked entry — `[仅本地]` and the extension, the time and the size — is kept and sent.
 */
let store: CrosslineStore;
let workspaceId: string;
let root: string;
const extracted: string[] = [];
const deps = () => ({ dataDir: path.join(root, "data"), home: path.join(root, "home"), readText: async (bytes: Uint8Array) => {
  const text = Buffer.from(bytes).toString("utf8");
  extracted.push(text);
  return { status: "done" as const, text };
} });
const put = (relative: string, content: string) => { const full = path.join(root, relative); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, content); };
const folders = () => readSourceFolders(store.getSetting(workspaceId, SOURCE_FOLDERS_SETTING));
const markLocalOnly = (id: string, on: boolean) => store.setSetting(workspaceId, SOURCE_FOLDERS_SETTING,
  JSON.stringify(folders().map((folder) => folder.id === id ? { ...folder, ...(on ? { localOnly: true } : {}), ...(on ? {} : { localOnly: undefined }) } : folder)));

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人").workspace.id;
  root = mkdtempSync(path.join(tmpdir(), "crossline-local-only-"));
  extracted.length = 0;
});
afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });

test("a 「仅本地」 folder's files are never read: only a masked name, time and size are kept and sent, and what was read before goes", async () => {
  put("unpublished/results.md", "secret measurement 42.7 dB");
  put("unpublished/draft.txt", "unpublished draft");
  const added = await addFolder(store, workspaceId, path.join(root, "unpublished"), deps());
  if (added.state !== "added") throw new Error("not added");
  // Read once before the mark: the content is in the ledger.
  await syncFolder(store, workspaceId, folders()[0]!, deps());
  expect(store.listSourceDocuments(workspaceId).map((doc) => doc.extractedText)).toContain("secret measurement 42.7 dB");

  markLocalOnly(added.folder.id, true);
  extracted.length = 0;
  await syncFolder(store, workspaceId, folders()[0]!, deps());
  expect(extracted).toEqual([]);
  const docs = store.listSourceDocuments(workspaceId);
  expect(docs.map((doc) => doc.fileName).sort()).toEqual(["[仅本地]/[仅本地].md", "[仅本地]/[仅本地].txt"]);
  expect(docs.every((doc) => doc.extractedText === "" && !doc.uri.startsWith("file:"))).toBe(true);
  expect(docs.map((doc) => doc.extractionNote).join(" ")).toMatch(/\d+ 字节/);
  expect(JSON.stringify(docs)).not.toMatch(/results|draft|unpublished|42\.7/);
  expect([...folderDocuments(store, workspaceId).keys()].sort()).toEqual(docs.map((doc) => doc.id).sort());

  // What a linked device sends: the masked entries, a masked folder label, nothing of the names.
  const sent = JSON.stringify(sourceItems(store, workspaceId, readDeviceState(path.join(root, "device"))).map((item) => item.body));
  expect(sent).toContain("[仅本地]");
  expect(sent).not.toMatch(/results|draft|unpublished|42\.7/);

  // The interview cannot list or open it either.
  expect(JSON.stringify(await listFolderEntries(store, workspaceId, added.folder.id))).not.toMatch(/results|unpublished/);
  expect(JSON.stringify(await listFolderEntries(store, workspaceId, undefined))).not.toMatch(/unpublished/);
  expect(await readFolderFile(store, workspaceId, deps(), added.folder.id, "results.md")).toMatchObject({ ok: false });
  expect(extracted).toEqual([]);

  // Taken off: the masked entries go and the files are read as usual again.
  markLocalOnly(added.folder.id, false);
  await syncFolder(store, workspaceId, folders()[0]!, deps());
  expect(store.listSourceDocuments(workspaceId).map((doc) => doc.fileName).sort()).toEqual(["unpublished/draft.txt", "unpublished/results.md"]);
});

test("a file whose path hits a PDK term is not read, in an ordinary folder, with the person's own terms added", async () => {
  put("course/notes.md", "lecture notes");
  put("course/gf180-pdk/readme.md", "foundry confidential");
  put("course/sky130_corner.txt", "corner values");
  store.setSetting(workspaceId, PDK_TERMS_SETTING, JSON.stringify(["sky130"]));
  const added = await addFolder(store, workspaceId, path.join(root, "course"), deps());
  if (added.state !== "added") throw new Error("not added");
  await syncFolder(store, workspaceId, folders()[0]!, deps());
  expect(extracted).toEqual(["lecture notes"]);
  const names = store.listSourceDocuments(workspaceId).map((doc) => doc.fileName).sort();
  expect(names).toEqual(["course/[仅本地].md", "course/[仅本地].txt", "course/notes.md"]);
  expect(await readFolderFile(store, workspaceId, deps(), added.folder.id, "sky130_corner.txt")).toMatchObject({ ok: false });
  expect(extracted).toEqual(["lecture notes"]);
});
