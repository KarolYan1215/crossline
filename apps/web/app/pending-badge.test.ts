import { expect, test } from "vitest";
import { pendingViewOf } from "./pending-badge";

test("the shared pending reading takes 待确认's total, the asks alone and what waits for later from one answer", () => {
  expect(pendingViewOf({ ok: true, total: 22, asks: 15, workOrders: 4, later: { total: 61 } })).toEqual({ total: 22, asks: 15, later: 61 });
  expect(pendingViewOf({ ok: true, total: 3 })).toEqual({ total: 3, asks: 0, later: 0 });
  expect(pendingViewOf({ ok: false, code: "UNAUTHENTICATED" })).toBeUndefined();
  expect(pendingViewOf(undefined)).toBeUndefined();
});
