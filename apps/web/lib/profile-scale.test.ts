import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { PROFILE_INSTRUMENTS_SETTING, readInstrumentAnswers } from "@crossline/core";
vi.mock("server-only", () => ({}));
import { changeScale, loadScale, readScaleChange } from "./profile-scale";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });
const ws = TEST_CTX.workspaceId;

test("the scale page: seven pages, answers kept as tapped or skipped, a score off an item's scale refused", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const empty = loadScale(TEST_CTX);
  expect(empty.pages).toHaveLength(7);
  expect(empty.pages[0]![0]).toMatchObject({ id: "neo-1", points: 5 });
  expect(empty.pages[6]![0]!.labels).toHaveLength(6);
  expect(empty.status).toMatchObject({ state: "todo", total: 140 });
  expect(changeScale(TEST_CTX, { action: "answers", answers: [{ itemId: "neo-1", score: 4 }, { itemId: "neo-2", score: null }, { itemId: "twivi-1", score: 6 }] })).toEqual({ ok: true });
  expect(readInstrumentAnswers(store.getSetting(ws, PROFILE_INSTRUMENTS_SETTING))).toMatchObject({ "neo-1": { by: "tapped", score: 4 }, "neo-2": { by: "skipped" } });
  expect(loadScale(TEST_CTX).answers).toEqual({ "neo-1": { score: 4 }, "neo-2": { skipped: true }, "twivi-1": { score: 6 } });
  expect(changeScale(TEST_CTX, { action: "answers", answers: [{ itemId: "neo-3", score: 6 }] })).toEqual({ ok: false, code: "PROFILE_ITEM_SCORE" });
  expect(changeScale(TEST_CTX, { action: "answers", answers: [{ itemId: "ipip-1", score: 3 }] })).toEqual({ ok: false, code: "PROFILE_ITEM_UNKNOWN" });
  expect(loadScale(TEST_CTX).status).toMatchObject({ state: "in_progress", answered: 3 });
});

test("paused and taken up again: the page, the box, self-reports as the person said them; put off, then done", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  changeScale(TEST_CTX, { action: "page", page: 3 });
  changeScale(TEST_CTX, { action: "supplement", text: "  做题那天很累  " });
  changeScale(TEST_CTX, { action: "self_reports", reports: [{ test: "16 型人格", result: "ENFP" }, { test: "", result: "x" }] });
  expect(loadScale(TEST_CTX).session).toMatchObject({ page: 3, supplement: "做题那天很累", selfReports: [{ test: "16 型人格", result: "ENFP" }] });
  expect(changeScale(TEST_CTX, { action: "page", page: 9 })).toEqual({ ok: false, code: "SCALE_PAGE_INVALID" });
  changeScale(TEST_CTX, { action: "defer" });
  expect(loadScale(TEST_CTX).status.deferred).toBe(true);
  changeScale(TEST_CTX, { action: "resume" });
  expect(loadScale(TEST_CTX).session.deferredAt).toBeUndefined();
  changeScale(TEST_CTX, { action: "complete" });
  expect(loadScale(TEST_CTX).status.state).toBe("done");
});

test("only well-formed changes are read", () => {
  expect(readScaleChange({ action: "answers", answers: [{ itemId: "neo-1", score: 3 }] })).toMatchObject({ action: "answers" });
  expect(readScaleChange({ action: "answers", answers: [{ itemId: 3 }] })).toBeNull();
  expect(readScaleChange({ action: "supplement", text: "x".repeat(5000) })).toBeNull();
  expect(readScaleChange({ action: "complete" })).toEqual({ action: "complete" });
  expect(readScaleChange({ action: "nope" })).toBeNull();
});
