import { afterEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { FILE_PAGE, interviewReadTools, LEDGER_PAGE } from "./onboarding-read-tools";

// P3 (docs/onboarding-agent-session.md 「读工具」): what a turn's context shows only in part is read in full, page by page.
let store: CrosslineStore | undefined;
afterEach(() => { store?.close(); store = undefined; });

test("read_file reads a file past the turn's budget page by page; read_ledger pages the questions and facts; a wrong name says what is allowed", async () => {
  store = new CrosslineStore(":memory:");
  const ws = store.createPrincipalWithWorkspace("user-1", "w").workspace.id;
  const text = "甲".repeat(FILE_PAGE) + "乙".repeat(10);
  store.saveSourceDocument({ id: "doc-1", ownerId: "o", workspaceId: ws, kind: "text", fileName: "Plan.txt", mediaType: "text/plain", sha256: "1", uri: "file:///1",
    extractedText: text, extractionStatus: "done", createdAt: "2026-11-14T00:00:00Z" });
  const at = "2026-11-14T05:00:00Z";
  for (let index = 0; index < LEDGER_PAGE + 2; index += 1) store.recordQuestion(ws, { kind: "interview", key: `iq:s1:${index}:q1`, text: `第 ${index} 题？`, status: "open", at });
  store.upsertProfileFact({ workspaceId: ws, identityId: "research", projectId: "", slot: "what", value: "博士研究", status: "confirmed", sourceRef: "reply-1", sourceQuote: "博士研究", updatedAt: at });
  const tools = interviewReadTools(store, ws, "s1");
  const first = await tools.call("read_file", { id: "doc-1" });
  expect(first).toContain(`接着读用 offset ${FILE_PAGE}`);
  expect(await tools.call("read_file", { id: "doc-1", offset: FILE_PAGE })).toContain("已读完");
  expect(() => tools.call("read_file", { id: "nope" })).toThrow("没有 id 为「nope」");
  expect(await tools.call("read_ledger", { section: "questions" })).toContain("第 1/2 页");
  expect(await tools.call("read_ledger", { section: "questions", page: 1 })).toContain(`第 ${LEDGER_PAGE + 1} 题？`);
  expect(await tools.call("read_ledger", { section: "facts" })).toContain("research · what = 博士研究（确认）");
  expect(await tools.call("read_ledger", { section: "research" })).toContain("没有记录");
  expect(() => tools.call("read_ledger", { section: "secrets" })).toThrow("section 只能是");
});
