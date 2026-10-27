import { describe, expect, it, vi } from "vitest";
import { afterMiss, type RuntimeCheck } from "./runtime-status";

vi.mock("server-only", () => ({}));

const signedOut = { code: "signed_out" as const, title: "还没有连接模型", message: "" };

describe("afterMiss", () => {
  it("does not call the worker down on one slow answer", () => {
    const ok: RuntimeCheck = { at: 0, status: null, misses: 0 };
    expect(afterMiss(ok, 60_000)).toEqual({ at: 60_000, status: null, misses: 1 });
  });

  it("keeps the last status that reached the worker on one miss", () => {
    const ok: RuntimeCheck = { at: 0, status: signedOut, misses: 0 };
    expect(afterMiss(ok, 60_000).status).toBe(signedOut);
  });

  it("calls the worker down on the second miss in a row", () => {
    const first = afterMiss({ at: 0, status: null, misses: 0 }, 60_000);
    const second = afterMiss(first, 70_000);
    expect(second.misses).toBe(2);
    expect(second.status?.code).toBe("worker_down");
    expect(afterMiss(second, 80_000).status?.code).toBe("worker_down");
  });

  it("calls the worker down on the second miss when nothing reached it before", () => {
    expect(afterMiss(undefined, 0).status).toBeNull();
    expect(afterMiss(afterMiss(undefined, 0), 10_000).status?.code).toBe("worker_down");
  });

  it("does not count misses far apart together", () => {
    const first = afterMiss({ at: 0, status: null, misses: 0 }, 60_000);
    const later = afterMiss(first, 60_000 + 6 * 60_000);
    expect(later.misses).toBe(1);
    expect(later.status).toBeNull();
  });
});
