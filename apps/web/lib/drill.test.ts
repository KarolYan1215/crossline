import type { EventType } from "@crossline/core";
import type { LedgerEventInput } from "@crossline/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";

vi.mock("server-only", () => ({}));
const { answerDrill, loadDrill } = await import("./drill");
const { TEST_CTX } = await import("./test-support");

/** J7's web half: the exercise is shown without its key until graded; the person answers once. */
const WEEK = "2026-11-23";
const KEY = [{ line: 4, description: "写指针回绕少比较一位", failingCheck: "FAIL pop_order t=95", original: "== DEPTH", replacement: "== DEPTH-1" },
  { line: 9, description: "复位值错", failingCheck: "FAIL reset t=5", original: "<= 0", replacement: "<= 1" }];

const store = () => globalThis.crosslineStore!;
const append = (type: EventType, entityId: string, payload: unknown) => store().appendEvent({ ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId,
  type, entityId, idempotencyKey: `${type}:${entityId}:${JSON.stringify(payload)}`, payload } as LedgerEventInput);

beforeEach(() => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  append("gate.changed", "2026-11-16", { week: "2026-11-16", title: "计数器找错", topic: "counter", files: [], key: [KEY[0], KEY[1], KEY[0]], promptVersion: "v1", change: "drill_issued" });
  append("gate.changed", "old-answer", { week: "2026-11-16", found: 2, total: 3, falsePositives: 0, judgedId: "j0", change: "drill_graded" });
  append("gate.changed", WEEK, { week: WEEK, title: "同步 FIFO 找错", topic: "sync fifo", promptVersion: "v1", key: KEY,
    files: [{ name: "dut.sv", text: "module fifo;\nendmodule\n" }, { name: "tb.sv", text: "module tb;\nendmodule\n" }, { name: "README.md", text: "# 说明" }], change: "drill_issued" });
});
afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("the current exercise and the trend are shown, and nothing of the key before it is graded", () => {
  const view = loadDrill(TEST_CTX);
  expect(view.current).toMatchObject({ week: WEEK, title: "同步 FIFO 找错", bugCount: 2 });
  expect(view.current!.files.map((file) => file.name)).toEqual(["dut.sv", "tb.sv", "README.md"]);
  expect(view.history).toEqual([{ week: WEEK, title: "同步 FIFO 找错", total: 2, found: null }, { week: "2026-11-16", title: "计数器找错", total: 3, found: 2 }]);
  const text = JSON.stringify(view);
  for (const secret of ["写指针回绕", "复位值错", "FAIL pop_order", "DEPTH-1", "failingCheck", "\"key\""]) expect(text).not.toContain(secret);
});

test("an answer is recorded once; bad input and unknown weeks are refused", () => {
  expect(answerDrill(TEST_CTX, { week: "2026-01-05", answers: [{ line: 1, description: "x" }] })).toEqual({ ok: false, code: "DRILL_NOT_FOUND" });
  expect(answerDrill(TEST_CTX, { week: WEEK, answers: [] })).toEqual({ ok: false, code: "DRILL_ANSWER_INVALID" });
  expect(answerDrill(TEST_CTX, { week: WEEK, answers: [{ line: 0, description: "x" }] })).toEqual({ ok: false, code: "DRILL_ANSWER_INVALID" });
  expect(answerDrill(TEST_CTX, { week: WEEK, answers: [{ line: 3, description: " " }] })).toEqual({ ok: false, code: "DRILL_ANSWER_INVALID" });
  expect(answerDrill(TEST_CTX, { week: WEEK, answers: [{ line: 4, description: "回绕少一位" }], fixedFile: { name: "C:\\work\\dut.sv", text: "module fifo; endmodule" } }))
    .toEqual({ ok: true });
  expect(answerDrill(TEST_CTX, { week: WEEK, answers: [{ line: 9, description: "复位" }] })).toEqual({ ok: false, code: "DRILL_ALREADY_ANSWERED" });
  const [event] = store().listEvents(TEST_CTX.workspaceId, { type: "gate.changed", change: "drill_answered" });
  expect(event!.payload).toMatchObject({ week: WEEK, answers: [{ line: 4, description: "回绕少一位" }], fixedFile: { name: "dut.sv" } });
  const view = loadDrill(TEST_CTX);
  expect(view.current!.answered).toMatchObject({ answers: [{ line: 4, description: "回绕少一位" }], fixedFileName: "dut.sv" });
  expect(JSON.stringify(view)).not.toContain("写指针回绕");
});

test("once graded, the key is shown bug by bug with the judgement, and the week joins the trend", () => {
  answerDrill(TEST_CTX, { week: WEEK, answers: [{ line: 4, description: "回绕少一位" }] });
  const answered = store().listEvents(TEST_CTX.workspaceId, { type: "gate.changed", change: "drill_answered" })[0]!;
  const judged = append("gate.judged", answered.eventId, { gate: "drill", subject: { kind: "drill", id: answered.eventId }, run: 1, asked: false,
    output: { verdict: "graded", detail: { found: 1, total: 2, falsePositives: 0, fixedFile: "not_attached",
      matches: [{ bug: "B1", verdict: "found", answer: "A1", why: "行号与原因一致" }, { bug: "B2", verdict: "missed", answer: "", why: "未提及" }] } } });
  append("gate.changed", answered.eventId, { week: WEEK, found: 1, total: 2, falsePositives: 0, judgedId: judged.eventId, change: "drill_graded" });
  const view = loadDrill(TEST_CTX);
  expect(view.current!.graded).toMatchObject({ found: 1, total: 2, bugs: [
    { line: 4, description: "写指针回绕少比较一位", verdict: "found", why: "行号与原因一致" }, { line: 9, description: "复位值错", verdict: "missed" }] });
  expect(view.history[0]).toMatchObject({ week: WEEK, found: 1, total: 2 });
});

test("another workspace sees nothing and cannot answer", () => {
  const other = { ...TEST_CTX, workspaceId: "someone-else" };
  expect(loadDrill(other)).toEqual({ history: [] });
  expect(answerDrill(other, { week: WEEK, answers: [{ line: 1, description: "x" }] })).toEqual({ ok: false, code: "DRILL_NOT_FOUND" });
});
