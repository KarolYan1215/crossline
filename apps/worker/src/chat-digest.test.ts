import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { CHAT_DIGEST_SETTING, chatHistorySegments, chatHistoryText, readChatDigests, validateChatDigest } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { CHAT_NOTE_ID, createChatDigester } from "./chat-digest";
import { transcriptDocumentIds } from "./recording-digest";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let workspaceId: string;
let data: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "w").workspace.id;
  data = mkdtempSync(path.join(tmpdir(), "crossline-chats-"));
});
afterEach(() => { store.close(); rmSync(data, { recursive: true, force: true }); });

const exportText = chatHistoryText({ format: "chatgpt", conversations: [
  { title: "论文投稿", startedAt: "2026-03-02", said: ["我的 MoS2 论文 3 月 15 日前要投出，帮我看看摘要", "第二段太长了\n要缩到 150 字"] },
  { title: "Python 报错", startedAt: "2026-03-05", said: ["Traceback (most recent call last): KeyError 'date'"] }] });
const save = (id: string, fileName: string, text: string) => store.saveSourceDocument({ id, ownerId: "user-1", workspaceId, kind: "text", fileName,
  mediaType: "text/plain", sha256: id, uri: `file:///${id}`, extractedText: text, extractionStatus: "done", createdAt: "2026-03-10T00:00:00Z" });

test("an export document is read back into its conversations; any other document is not one", () => {
  const segments = chatHistorySegments(exportText)!;
  expect(segments.map((segment) => segment.heading)).toEqual(["2026-03-02 论文投稿", "2026-03-05 Python 报错"]);
  expect(segments[0]!.said).toContain("要缩到 150 字");
  expect(chatHistorySegments("# 研究计划\n\n## 背景\n正文")).toBeUndefined();
  expect(validateChatDigest({ segments: [{ id: "s0", summary: "a" }, { id: "s0", summary: "b" }, { id: "s9", summary: "c" }, { id: "s1", summary: " " }] }, ["s0", "s1"]))
    .toEqual({ segments: [{ id: "s0", summary: "a" }] });
});

test("each conversation of an AI chat export gets the model's summary; the interview then reads the note instead of the export", async () => {
  save("chat", "conversations.json", exportText);
  save("plan", "计划.md", "# 研究计划\n正文");
  const answer = JSON.stringify({ segments: [{ id: "s0", summary: "本人在改 MoS2 论文的摘要，3 月 15 日前要投出。" }, { id: "s1", summary: "主要贴了 Python 报错日志。" }] });
  const runtime = fakeRuntime([answer], "crossline:crossline-source-digest");
  expect(await createChatDigester(store, workspaceId, "C:\\repo", () => runtime.rpc, { dataDir: data })()).toEqual({ summarized: 2, notes: 1 });
  // Only the person's words went to the model, by conversation.
  expect(runtime.prompts().join("\n")).toContain("crossline.chat-digest.v1");
  expect(runtime.prompts().join("\n")).not.toContain("研究计划");
  const note = store.listSourceDocuments(workspaceId).find((doc) => doc.id === `${CHAT_NOTE_ID}chat`)!;
  expect(note.extractedText).toContain("## 2026-03-02 论文投稿");
  expect(note.extractedText).toContain("3 月 15 日前要投出");
  expect(note.extractedText).toContain("read_file");
  expect(transcriptDocumentIds(store, workspaceId).has("chat")).toBe(true);
  expect(readChatDigests(store.getSetting(workspaceId, CHAT_DIGEST_SETTING)).chat?.noteDocumentId).toBe(note.id);
  // Done: nothing is asked again.
  expect(await createChatDigester(store, workspaceId, "C:\\repo", () => undefined, { dataDir: data })()).toEqual({ summarized: 0, notes: 0 });
});

test("a conversation the model passes over twice is written into the note without a summary, so the note is not held back", async () => {
  save("chat", "conversations.json", exportText);
  const partial = JSON.stringify({ segments: [{ id: "s0", summary: "本人在改论文摘要。" }] });
  const none = JSON.stringify({ segments: [] });
  const runtime = fakeRuntime([partial, none], "crossline:crossline-source-digest");
  expect(await createChatDigester(store, workspaceId, "C:\\repo", () => runtime.rpc, { dataDir: data })()).toEqual({ summarized: 1, notes: 1 });
  const note = store.listSourceDocuments(workspaceId).find((doc) => doc.id === `${CHAT_NOTE_ID}chat`)!;
  expect(note.extractedText).toContain("本人在改论文摘要。");
  expect(note.extractedText).toContain("没有写出摘要");
});
