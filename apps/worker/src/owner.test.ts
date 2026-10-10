import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { MONTHLY_BUDGET_SETTING, monthSpend, runtimeOwner } from "./owner";

let store: CrosslineStore;
beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

test("the machine's Codex belongs to the first account on it, decided once; a later account never takes it over", () => {
  const owner = store.createPrincipalWithWorkspace("owner", "个人").workspace.id;
  const guest = store.createPrincipalWithWorkspace("guest", "个人").workspace.id;
  expect(runtimeOwner(store, {})).toBe(owner);
  // Even when the env later names someone else, the recorded owner stands.
  expect(runtimeOwner(store, { CROSSLINE_RUNTIME_LEGACY_WORKSPACE: guest })).toBe(owner);
});

test("on a machine with several accounts and no record yet, the env names the owner", () => {
  store.createPrincipalWithWorkspace("a", "个人");
  const named = store.createPrincipalWithWorkspace("b", "个人").workspace.id;
  expect(runtimeOwner(store, { CROSSLINE_RUNTIME_LEGACY_WORKSPACE: named })).toBe(named);
});

test("a pay-per-use month is this month's tokens at the rate, against $10 unless the person set another cap", () => {
  const ws = store.createPrincipalWithWorkspace("u", "个人").workspace.id;
  const row = (at: string) => store.saveModelUsage({ workspaceId: ws, skill: "s", tier: "mid", model: "m", effort: "", spendMode: "normal", threadId: "", ok: true,
    errorCode: "", repairs: 0, turns: 1, inputTokens: 100_000, cachedInputTokens: 0, outputTokens: 50_000, reasoningTokens: 0, totalTokens: 150_000, durationMs: 1, at });
  row("2026-09-30T23:00:00.000Z"); row("2026-10-02T10:00:00.000Z");
  const now = new Date("2026-10-10T12:00:00Z");
  expect(monthSpend(store, ws, now)).toEqual({ spent: 3, cap: 10 });
  store.setSetting(ws, MONTHLY_BUDGET_SETTING, "25");
  expect(monthSpend(store, ws, now).cap).toBe(25);
});
