import { expect, test } from "vitest";
import { accountModels, fitRoute, forgetAccountModels, routeForChoice, type CatalogModel } from "./model-catalog";
import { DEFAULT_TIERS } from "./model-policy";

const model = (name: string, extra: Partial<CatalogModel> = {}): CatalogModel =>
  ({ model: name, hidden: false, isDefault: false, efforts: ["low", "medium", "high"], defaultEffort: "medium", ...extra });

test("a model the account has is kept; one it lacks falls down the tier ladder, then to the account's default", () => {
  const plus = [model("gpt-6.2-sol"), model("gpt-6.1-terra"), model("gpt-6-luna")];
  expect(fitRoute({ model: "gpt-6.2-sol", effort: "medium" }, "top", plus, DEFAULT_TIERS)).toEqual({ model: "gpt-6.2-sol", effort: "medium" });
  // A Free account offered no `-sol`: the interview runs on the middle tier instead of failing.
  const free = [model("gpt-6.1-terra", { efforts: ["low", "medium"], defaultEffort: "low" }), model("gpt-6-luna", { isDefault: true })];
  expect(fitRoute({ model: "gpt-6.2-sol", effort: "medium" }, "top", free, DEFAULT_TIERS)).toEqual({ model: "gpt-6.1-terra", effort: "medium" });
  // The middle tier's own effort (high) is not offered there: the model's default is taken.
  expect(fitRoute({ model: "gpt-6.1-terra", effort: "high" }, "mid", free, DEFAULT_TIERS)).toEqual({ model: "gpt-6.1-terra", effort: "low" });
  // None of the tier models: the account's default.
  const other = [model("gpt-5.5-mini", { hidden: true }), model("gpt-5.5", { isDefault: true, efforts: [] , defaultEffort: "" })];
  expect(fitRoute({ model: "gpt-6.2-sol", effort: "medium", maxRepairs: 3 }, "top", other, DEFAULT_TIERS)).toEqual({ model: "gpt-5.5", effort: "medium", maxRepairs: 3 });
  // Nothing known: the route stands.
  expect(fitRoute({ model: "gpt-6.2-sol" }, "top", null, DEFAULT_TIERS)).toEqual({ model: "gpt-6.2-sol" });
});

test("a missing model takes the newest listed one of its family before stepping down a tier", () => {
  // The 0.163.0 runtime's catalogue on a Plus plan (2026-11-26): gpt-6.2-sol needs 0.166.0 and is left out.
  const old = [model("gpt-6.1-terra"), model("gpt-reserve", { hidden: true }), model("gpt-6-sol"), model("gpt-6.1-sol"),
    model("gpt-6-astra"), model("gpt-6-luna"), model("gpt-5.6-sol"), model("gpt-5.6-terra")];
  expect(fitRoute({ model: "gpt-6.2-sol", effort: "medium" }, "top", old, DEFAULT_TIERS)).toEqual({ model: "gpt-6.1-sol", effort: "medium" });
  expect(fitRoute({ model: "gpt-6.2-sol", effort: "medium" }, "top", old.filter((item) => item.model !== "gpt-6.1-sol"), DEFAULT_TIERS))
    .toEqual({ model: "gpt-6-sol", effort: "medium" });
  // A hidden one of the family is not taken; with no visible sol the tier ladder applies as before.
  const hiddenSol = [model("gpt-6.1-sol", { hidden: true }), model("gpt-6.1-terra")];
  expect(fitRoute({ model: "gpt-6.2-sol", effort: "medium" }, "top", hiddenSol, DEFAULT_TIERS)).toEqual({ model: "gpt-6.1-terra", effort: "medium" });
  // Another prefix is another family.
  expect(fitRoute({ model: "gpt-6.2-sol", effort: "medium" }, "top", [model("o-6.1-sol"), model("gpt-6.1-terra")], DEFAULT_TIERS))
    .toEqual({ model: "gpt-6.1-terra", effort: "medium" });
});

test("the catalogue is read once per workspace for ten minutes, and a runtime that cannot say leaves routes alone", async () => {
  forgetAccountModels();
  let calls = 0;
  const client = { request: async (method: string) => {
    calls += 1;
    if (method !== "model/list") throw new Error("unexpected");
    return { data: [{ id: "a", model: "gpt-6.1-terra", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }], nextCursor: null };
  } } as never;
  expect(await accountModels(client, "ws", 0)).toEqual([{ model: "gpt-6.1-terra", hidden: false, isDefault: true, efforts: ["low"], defaultEffort: "low" }]);
  await accountModels(client, "ws", 60_000);
  expect(calls).toBe(1);
  forgetAccountModels("ws");
  await accountModels(client, "ws", 60_000);
  expect(calls).toBe(2);
  const broken = { request: async () => { throw new Error("method not found"); } } as never;
  expect(await accountModels(broken, "other", 0)).toBeNull();
});

test("the catalogue's own model name is kept for the picker when it says more than the id", async () => {
  forgetAccountModels();
  const client = { request: async () => ({ data: [
    { model: "gpt-6.2-sol", displayName: "GPT-5.6 Sol", hidden: false, isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: "medium" },
    { model: "gpt-6.1-terra", displayName: "gpt-6.1-terra", hidden: false, isDefault: true, supportedReasoningEfforts: [], defaultReasoningEffort: "medium" }], nextCursor: null }) } as never;
  const models = await accountModels(client, "named", 0);
  expect(models?.[0]?.displayName).toBe("GPT-5.6 Sol");
  expect(models?.[1]).not.toHaveProperty("displayName");
});

test("the person's own choice is kept as chosen, its effort fitted to the model, and never swapped for another model", () => {
  const plus = [model("gpt-6.2-sol", { efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" }), model("gpt-6.1-terra", { isDefault: true })];
  expect(routeForChoice({ model: "gpt-6.2-sol", effort: "xhigh" }, plus)).toEqual({ route: { model: "gpt-6.2-sol", effort: "xhigh" } });
  // An effort the model does not take falls to the model's own default, not to another model.
  expect(routeForChoice({ model: "gpt-6.1-terra", effort: "xhigh" }, plus)).toEqual({ route: { model: "gpt-6.1-terra", effort: "medium" } });
  // A model the account does not have is refused, where a table route would have fallen down the ladder.
  expect(routeForChoice({ model: "gpt-6-luna", effort: "low" }, plus)).toEqual({ unavailable: true });
  // No catalogue to ask: sent as chosen.
  expect(routeForChoice({ model: "gpt-6-luna" }, null)).toEqual({ route: { model: "gpt-6-luna" } });
});
