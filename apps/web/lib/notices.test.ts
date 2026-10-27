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

test("a reminder about a moment (a block about to start) leaves the bell after 12 hours; others stay the week", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  const now = new Date();
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  addNotice(TEST_CTX, "09:35 做作业", "block_start", [], hoursAgo(13));
  addNotice(TEST_CTX, "10:00 做阅读", "block_start", [], hoursAgo(2));
  addNotice(TEST_CTX, "助手做完了", "background_done", [], hoursAgo(30));
  expect(listNotices(TEST_CTX, now).items.map((item) => item.text)).toEqual(["10:00 做阅读", "助手做完了"]);
});
