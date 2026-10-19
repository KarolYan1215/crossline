import { afterEach, beforeEach, expect, test } from "vitest";
import { documentsByRef } from "@crossline/core";
import { CrosslineStore } from "./index";

let store: CrosslineStore;
const A = "workspace-a";
const B = "workspace-b";
const now = "2026-10-19T12:00:00.000Z";

beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

const doc = (id: string, sha256: string, text = "") => ({ id, ownerId: "o", workspaceId: A, kind: "text" as const, fileName: `${id}.txt`,
  mediaType: "text/plain", sha256, uri: `file:${id}`, extractedText: text, extractionStatus: "done" as const, createdAt: now });

test("sentences are numbered once per workspace and never move; a changed text retires the old ones and gets new ids", () => {
  const first = store.ensureEvidence(A, "reply", "s#1", "论文12月中投稿。数据还差一半。");
  expect(first.map((sentence) => [sentence.id, sentence.text])).toEqual([[1, "论文12月中投稿。"], [2, "数据还差一半。"]]);
  expect(store.ensureEvidence(A, "reply", "s#1", "论文12月中投稿。数据还差一半。").map((sentence) => sentence.id)).toEqual([1, 2]);
  expect(store.ensureEvidence(A, "reply", "s#3", "创业那边没截止。").map((sentence) => sentence.id)).toEqual([3]);
  // Another workspace counts from one on its own.
  expect(store.ensureEvidence(B, "reply", "s#1", "别的人。").map((sentence) => sentence.id)).toEqual([1]);

  store.saveSourceDocument(doc("d1", "h1", "旧的一行"));
  expect(store.ensureEvidence(A, "document", "d1", "旧的一行").map((sentence) => sentence.id)).toEqual([4]);
  expect(store.ensureEvidence(A, "document", "d1", "新的一行\n第二行内容").map((sentence) => sentence.id)).toEqual([5, 6]);
  expect(store.sentencesById(A, [4, 5]).map((sentence) => [sentence.text, sentence.retired])).toEqual([["旧的一行", true], ["新的一行", false]]);
});

test("a fact keeps the sentences it rests on; a guess never replaces a confirmed fact's sentences", () => {
  const key = { identityId: "research", projectId: "", slot: "deadline" };
  store.upsertProfileFact({ workspaceId: A, ...key, value: "12 月中", status: "confirmed", sourceRef: "reply-1", sourceQuote: "论文12月中投稿。",
    sourceSentences: [1], updatedAt: now });
  store.upsertProfileFact({ workspaceId: A, ...key, value: "12 月底", status: "inferred", sourceRef: "inference", sourceQuote: "", sourceSentences: [], updatedAt: now });
  expect(store.listProfileFacts(A)[0]).toMatchObject({ value: "12 月中", sourceSentences: [1] });
  store.upsertProfileFact({ workspaceId: A, identityId: "person", projectId: "", slot: "tone", value: "x", status: "inferred", sourceRef: "inference", sourceQuote: "", updatedAt: now });
  expect(store.listProfileFacts(A, { identityId: "person" })[0]!.sourceSentences).toBeUndefined();
});

test("a document's number is fixed at upload: removing one file no longer renumbers the files after it", () => {
  for (const [id, sha] of [["d1", "h1"], ["d2", "h2"], ["d3", "h3"]] as const) store.saveSourceDocument(doc(id, sha, `${id} 的内容在这里`));
  const sentence = store.ensureEvidence(A, "document", "d2", "d2 的内容在这里")[0]!;
  store.upsertProfileFact({ workspaceId: A, identityId: "research", projectId: "", slot: "x", value: "v", status: "confirmed", sourceRef: "src-2",
    sourceQuote: "d2 的内容在这里", sourceSentences: [sentence.id], updatedAt: now });
  store.deleteSourceDocument(A, "d1");
  const byRef = documentsByRef(store.listSourceDocuments(A));
  expect(byRef.get("src-2")?.id).toBe("d2");
  expect(byRef.get("src-3")?.id).toBe("d3");
  store.saveSourceDocument(doc("d4", "h4"));
  expect(documentsByRef(store.listSourceDocuments(A)).get("src-4")?.id).toBe("d4");
  // Removing a file takes its sentences with it and unhooks the facts that cited them; their quotes stay.
  store.deleteSourceDocument(A, "d2");
  expect(store.sentencesById(A, [sentence.id])).toEqual([]);
  expect(store.listProfileFacts(A)[0]).toMatchObject({ sourceQuote: "d2 的内容在这里" });
  expect(store.listProfileFacts(A)[0]!.sourceSentences).toBeUndefined();
});

test("facts written before numbered evidence get the sentences their quotes stand in, once", async () => {
  const { backfillFactEvidence } = await import("./evidence-backfill");
  const owner = store.createPrincipalWithWorkspace("user-1", "w");
  const ws = owner.workspace.id;
  for (const session of ["s1", "line-research"]) store.saveOnboardingSession({ id: session, ownerId: "o", workspaceId: ws, state: "active", coverage: {}, createdAt: now, updatedAt: now });
  // Both conversations have a message 1; only the line interview's holds the quote.
  store.appendOnboardingMessage({ sessionId: "s1", workspaceId: ws, role: "user", content: { text: "你好。我先说说情况。" }, createdAt: now });
  store.appendOnboardingMessage({ sessionId: "line-research", workspaceId: ws, role: "user", content: { text: "器件做完了。论文 **12 月中**投稿！" }, createdAt: now });
  store.saveSourceDocument({ ...doc("d1", "h1", "Week-8: 27th Oct.\nL15: Mid-term-1"), workspaceId: ws });
  const fact = (slot: string, sourceRef: string, sourceQuote: string) => store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: "", slot,
    value: "v", status: "confirmed", sourceRef, sourceQuote, updatedAt: now });
  fact("deadline", "reply-1", "论文12月中投稿");
  fact("midterm", "src-1", "27th Oct. L15: Mid-term-1");
  fact("lost", "reply-1", "从没说过的话");
  expect(backfillFactEvidence(store, ws)).toEqual({ linked: 2, unlinked: 1 });
  const facts = Object.fromEntries(store.listProfileFacts(ws).map((item) => [item.slot, item.sourceSentences]));
  const ids = (sentences: number[] | undefined) => store.sentencesById(ws, sentences ?? []).map((sentence) => sentence.text);
  expect(ids(facts.deadline)).toEqual(["论文 **12 月中**投稿！"]);
  expect(ids(facts.midterm)).toEqual(["Week-8: 27th Oct.", "L15: Mid-term-1"]);
  expect(facts.lost).toBeUndefined();
  expect(backfillFactEvidence(store, ws)).toBeUndefined();
});

test("a backup taken before document numbers gets them on restore, and an upload after it does not collide", () => {
  for (const [id, sha] of [["d1", "h1"], ["d2", "h2"]] as const) store.saveSourceDocument(doc(id, sha, `${id} 内容`));
  const snapshot = store.exportSnapshot(A);
  // As an older backup: the column did not exist.
  for (const row of snapshot.tables.source_documents ?? []) delete (row as Record<string, unknown>).ref_no;
  const target = new CrosslineStore(":memory:");
  try {
    target.importSnapshot(snapshot);
    target.saveSourceDocument(doc("d3", "h3"));
    expect([...documentsByRef(target.listSourceDocuments(A)).entries()].map(([ref, item]) => `${ref}=${item.id}`)).toEqual(["src-1=d1", "src-2=d2", "src-3=d3"]);
  } finally { target.close(); }
});
