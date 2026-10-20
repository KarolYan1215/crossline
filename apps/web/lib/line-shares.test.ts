import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { readLineShares, saveLineShares } from "./crossline";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("with nothing set on the plan page, shares follow the portrait's suggestion, not the share the person described", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(TEST_CTX.workspaceId, "portrait.report", JSON.stringify({ report: { lines: { allocation: "", items: [
    { lineId: "research", share: 55, targetShare: 60 }, { lineId: "startup", share: 22, targetShare: 20 },
    { lineId: "media", share: 13, targetShare: 12 }, { lineId: "investment", share: 10, targetShare: 8 }] } } }));
  expect(readLineShares(TEST_CTX)).toEqual({ research: 60, startup: 20, media: 12, investment: 8 });
  // An older report with no suggestion keeps the described share; a share set by hand wins over both.
  store.setSetting(TEST_CTX.workspaceId, "portrait.report", JSON.stringify({ report: { lines: { allocation: "", items: [
    { lineId: "research", share: 70 }, { lineId: "media", share: 30 }] } } }));
  expect(readLineShares(TEST_CTX)).toEqual({ research: 70, media: 30 });
  expect(saveLineShares(TEST_CTX, { research: 50, media: 50 })).toEqual({ ok: true });
  expect(readLineShares(TEST_CTX)).toEqual({ research: 50, media: 50 });
});
