import { expect, test } from "vitest";
import { handoffOutcome } from "./handoff";

test("a refusal the worker answered with 200 is a refusal, not 「已交给助手」 (W-151)", () => {
  expect(handoffOutcome({ ok: true, state: "started" })).toEqual({ kind: "started" });
  expect(handoffOutcome({ ok: true, state: "needs_category_approval" })).toEqual({ kind: "needs_category" });
  // Both were shown as handed over on the real account on 10-29, and nothing ran.
  expect(handoffOutcome({ ok: true, state: "blocked", message: "这件事的描述没有明确指向某一类工作，请选一类再交给助手。" }))
    .toEqual({ kind: "refused", message: "这件事的描述没有明确指向某一类工作，请选一类再交给助手。" });
  expect(handoffOutcome({ ok: false, blocker: { message: "没能交给助手。" } })).toEqual({ kind: "refused", message: "没能交给助手。" });
  expect(handoffOutcome(null)).toEqual({ kind: "refused", message: "" });
});
