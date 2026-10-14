import { expect, test } from "vitest";
import { aggregateSamples, sampleLocalActivity } from "./activity";

test("only three aggregate numbers leave the sampler, never a raw sequence", () => {
  const aggregate = aggregateSamples([
    { idleMs: 1_000, fgHandle: 11 },
    { idleMs: 2_000, fgHandle: 22 },
    { idleMs: 300_000, fgHandle: 22 },
    { idleMs: 500, fgHandle: 33 }
  ], 1);
  expect(aggregate).toEqual({ activeMinutes: 3, idleMinutes: 1, windowSwitches: 2 });
  expect(Object.keys(aggregate).sort()).toEqual(["activeMinutes", "idleMinutes", "windowSwitches"]);
});

test("a real sample carries a window handle and no window title", async () => {
  // A cold PowerShell compiling its helper type takes well over the default 10 s on a busy machine.
  const sample = await sampleLocalActivity(25_000);
  if (process.platform !== "win32") { expect(sample).toBeUndefined(); return; }
  expect(sample).toBeDefined();
  expect(Number.isFinite(sample!.idleMs)).toBe(true);
  // A handle is a number. If a title could ever appear here, this shape would have to change.
  expect(typeof sample!.fgHandle).toBe("number");
  expect(Object.keys(sample!).sort()).toEqual(["fgHandle", "idleMs"]);
}, 30_000);
