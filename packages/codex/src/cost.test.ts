import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { readCostSignal } from "./cost";
import { modelTierMapping } from "./model-tiers";

const client = (result: unknown) => ({
  request: async () => result,
  onNotification: () => () => {}
});

test("a real rate-limit snapshot becomes a vendor-neutral signal", async () => {
  const signal = await readCostSignal(client({
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: 41.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
        secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_800_600_000 },
        rateLimitReachedType: null
      }
    }
  }) as never);
  expect(signal).toEqual({
    available: true, limitReached: false,
    short: { usedPercent: 41.5, windowDurationMins: 300, resetsAt: 1_800_000_000 },
    long: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_800_600_000 }
  });
});

test("a missing or malformed reading is unavailable, never a fabricated zero", async () => {
  for (const shape of [{}, { rateLimitsByLimitId: {} }, { rateLimitsByLimitId: { codex: { primary: null, secondary: null } } }]) {
    const signal = await readCostSignal(client(shape) as never);
    expect(signal.available).toBe(false);
    // A "0% used" default here would read as permission to spend.
    expect(JSON.stringify(signal)).not.toContain("usedPercent");
  }
});

test("a thrown request is unavailable with a bounded reason, not a crash", async () => {
  const signal = await readCostSignal({
    request: async () => { throw new Error("x".repeat(400)); },
    onNotification: () => () => {}
  } as never);
  expect(signal.available).toBe(false);
  if (!signal.available) expect(signal.reason.length).toBeLessThanOrEqual(120);
});

test("a reached limit is carried through", async () => {
  const signal = await readCostSignal(client({
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null }, rateLimitReachedType: "rate_limit_reached" } }
  }) as never);
  expect(signal).toMatchObject({ available: true, limitReached: true });
});

// This package is the vendor-specific adapter; core must stay neutral so swapping the backend is one
// file. `packages/core` also has no node types on purpose, so the check lives here.
test("core's cost module names no currency and no vendor", () => {
  const source = readFileSync(path.resolve(import.meta.dirname, "../../core/src/cost.ts"), "utf8");
  // A monetary amount, not the "$" of a template literal.
  expect(source).not.toMatch(/$s?d/);
  for (const forbidden of ["USD", "dollar", "美元", "openai", "gpt-", "claude", "anthropic", "codex"]) {
    expect(source.toLowerCase()).not.toContain(forbidden.toLowerCase());
  }
});

test("model tiers come from the environment, and an unset tier is not given an invented default", () => {
  expect(modelTierMapping({ CROSSLINE_MODEL_ROUTINE: " small ", CROSSLINE_MODEL_CAPABLE: "large" }))
    .toEqual({ routine: "small", capable: "large" });
  // Naming a default here would pin work to a model nobody chose.
  expect(modelTierMapping({})).toEqual({});
  expect(modelTierMapping({ CROSSLINE_MODEL_ROUTINE: "  " })).toEqual({});
});
