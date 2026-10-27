import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { addNotice, listNotices, markNoticesRead } from "./notices";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("the bell lists reminders newest first, leaves out what asks for an answer, and counts what came after the last opening", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const now = new Date();
  const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  addNotice(TEST_CTX, "出发前检查油量", "errand_depart", [{ label: "看清单", href: "/workbench" }], at(30));
  const conversation = store.conversationFor(TEST_CTX.workspaceId, now.toISOString().slice(0, 10));
  store.appendConversationMessage({ id: "ask", workspaceId: TEST_CTX.workspaceId, conversationId: conversation.id, role: "nudge", text: "", createdAt: at(20).toISOString(),
    payload: { nudge: { kind: "block_confirm" }, card: { nudgeKind: "block_confirm", clarify: { question: "完成了吗？", options: [] } } } });
  addNotice(TEST_CTX, "邮件提醒：核实一笔交易", "mail_check", [], at(10));
  let body = listNotices(TEST_CTX, now);
  expect(body.items.map((item) => item.text)).toEqual(["邮件提醒：核实一笔交易", "出发前检查油量"]);
  expect(body.items[1]!.links).toEqual([{ label: "看清单", href: "/workbench" }]);
  expect(body.unread).toBe(2);
  markNoticesRead(TEST_CTX, at(15).toISOString());
  body = listNotices(TEST_CTX, now);
  expect(body.unread).toBe(1);
  markNoticesRead(TEST_CTX, at(60).toISOString());
  expect(listNotices(TEST_CTX, now).unread).toBe(1);
});
