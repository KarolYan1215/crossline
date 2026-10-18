import { expect, test } from "vitest";
import { accountModels, fitRoute, forgetAccountModels, type CatalogModel } from "./model-catalog";
import { DEFAULT_TIERS } from "./model-policy";

const model = (name: string, extra: Partial<CatalogModel> = {}): CatalogModel =>
  ({ model: name, hidden: false, isDefault: false, efforts: ["low", "medium", "high"], defaultEffort: "medium", ...extra });

test("a model the account has is kept; one it lacks falls down the tier ladder, then to the account's default", () => {
  const plus = [model("gpt-5.6-sol"), model("gpt-5.6-terra"), model("gpt-5.6-luna")];
  expect(fitRoute({ model: "gpt-5.6-sol", effort: "medium" }, "top", plus, DEFAULT_TIERS)).toEqual({ model: "gpt-5.6-sol", effort: "medium" });
  // A Free account offered no `-sol`: the interview runs on the middle tier instead of failing.
  const free = [model("gpt-5.6-terra", { efforts: ["low", "medium"], defaultEffort: "low" }), model("gpt-5.6-luna", { isDefault: true })];
  expect(fitRoute({ model: "gpt-5.6-sol", effort: "medium" }, "top", free, DEFAULT_TIERS)).toEqual({ model: "gpt-5.6-terra", effort: "medium" });
  // The middle tier's own effort (high) is not offered there: the model's default is taken.
  expect(fitRoute({ model: "gpt-5.6-terra", effort: "high" }, "mid", free, DEFAULT_TIERS)).toEqual({ model: "gpt-5.6-terra", effort: "low" });
  // None of the tier models: the account's default.
  const other = [model("gpt-5.5-mini", { hidden: true }), model("gpt-5.5", { isDefault: true, efforts: [] , defaultEffort: "" })];
  expect(fitRoute({ model: "gpt-5.6-sol", effort: "medium", maxRepairs: 3 }, "top", other, DEFAULT_TIERS)).toEqual({ model: "gpt-5.5", effort: "medium", maxRepairs: 3 });
  // Nothing known: the route stands.
  expect(fitRoute({ model: "gpt-5.6-sol" }, "top", null, DEFAULT_TIERS)).toEqual({ model: "gpt-5.6-sol" });
});

test("the catalogue is read once per workspace for ten minutes, and a runtime that cannot say leaves routes alone", async () => {
  forgetAccountModels();
  let calls = 0;
  const client = { request: async (method: string) => {
    calls += 1;
    if (method !== "model/list") throw new Error("unexpected");
    return { data: [{ id: "a", model: "gpt-5.6-terra", hidden: false, isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low" }], nextCursor: null };
  } } as never;
  expect(await accountModels(client, "ws", 0)).toEqual([{ model: "gpt-5.6-terra", hidden: false, isDefault: true, efforts: ["low"], defaultEffort: "low" }]);
  await accountModels(client, "ws", 60_000);
  expect(calls).toBe(1);
  forgetAccountModels("ws");
  await accountModels(client, "ws", 60_000);
  expect(calls).toBe(2);
  const broken = { request: async () => { throw new Error("method not found"); } } as never;
  expect(await accountModels(broken, "other", 0)).toBeNull();
});
