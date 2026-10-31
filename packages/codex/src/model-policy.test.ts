import { expect, test } from "vitest";
import { DEFAULT_TIERS, SKILL_TIERS, routeForSkill, tierRoutes, shiftEffort } from "./model-policy";

test("each Skill routes to its tier, with or without the plugin prefix", () => {
  expect(routeForSkill("crossline:crossline-onboarding", {})).toEqual(DEFAULT_TIERS.top);
  expect(routeForSkill("crossline-milestone-gate", {})).toEqual(DEFAULT_TIERS.mid);
  expect(routeForSkill("crossline:crossline-background-facts", {})).toEqual(DEFAULT_TIERS.low);
});

test("the three tiers are one model at three efforts", () => {
  expect(DEFAULT_TIERS.top).toEqual({ model: "gpt-5.6-terra", effort: "high" });
  expect(DEFAULT_TIERS.mid).toEqual({ model: "gpt-5.6-terra", effort: "medium" });
  expect(DEFAULT_TIERS.low).toEqual({ model: "gpt-5.6-terra", effort: "low" });
});

test("an unlisted Skill gets no route instead of a guessed one", () => {
  expect(routeForSkill("crossline:something-new", {})).toBeUndefined();
});

test("a tier can be swapped for another model by environment, with or without an effort", () => {
  const env = { CROSSLINE_MODEL_MID: "local-llama:low", CROSSLINE_MODEL_LOW: "tiny-model" };
  expect(tierRoutes(env).mid).toEqual({ model: "local-llama", effort: "low" });
  expect(tierRoutes(env).low).toEqual({ model: "tiny-model" });
  expect(routeForSkill("crossline-milestone-gate", env)).toEqual({ model: "local-llama", effort: "low" });
});

test("routing can be switched off wholesale", () => {
  expect(routeForSkill("crossline-onboarding", { CROSSLINE_MODEL_ROUTING: "off" })).toBeUndefined();
});

test("every routed Skill actually has a skill directory", async () => {
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = join(__dirname, "../../../skills/marketplace/plugins/crossline/skills");
  // New Skills land with their phase; only the ones that exist today must resolve.
  const pending = new Set(["crossline-due-diligence"]);
  for (const name of Object.keys(SKILL_TIERS)) {
    if (!pending.has(name)) expect(existsSync(join(root, name)), name).toBe(true);
  }
});

test("in economy mode a Skill steps down one tier, and the lowest stays where it is", () => {
  expect(routeForSkill("crossline-onboarding", {}, "economy")).toEqual(DEFAULT_TIERS.mid);
  expect(routeForSkill("crossline-due-diligence", {}, "economy")).toEqual(DEFAULT_TIERS.low);
  expect(routeForSkill("crossline-plan-explainer", {}, "economy")).toEqual(DEFAULT_TIERS.low);
});

test("the gate and the capture analysis never step down", () => {
  for (const skill of ["crossline-milestone-gate", "crossline-automation-stripper"]) {
    expect(routeForSkill(skill, {}, "economy")).toEqual(routeForSkill(skill, {}, "normal"));
  }
});

test("one Skill can be pinned by environment, and a pin wins over the tier and the budget", () => {
  const env = { CROSSLINE_ROUTE_CROSSLINE_ONBOARDING: "local-llama:low" };
  expect(routeForSkill("crossline:crossline-onboarding", env)).toEqual({ model: "local-llama", effort: "low" });
  expect(routeForSkill("crossline-onboarding", env, "economy")).toEqual({ model: "local-llama", effort: "low" });
  expect(routeForSkill("crossline-milestone-architect", env)).toEqual(DEFAULT_TIERS.top);
});

test("模型强度 moves each Skill's effort one step, to an effort the model takes", () => {
  const route = { model: "gpt-5.6-terra", effort: "medium" };
  expect(shiftEffort(route, "default")).toEqual(route);
  expect(shiftEffort(route, "higher")?.effort).toBe("high");
  expect(shiftEffort(route, "lower")?.effort).toBe("low");
  // Without a catalogue only low/medium/high are tried; with one, xhigh is reached and a gap is skipped.
  expect(shiftEffort({ ...route, effort: "high" }, "higher")?.effort).toBe("high");
  expect(shiftEffort({ ...route, effort: "high" }, "higher", ["low", "medium", "high", "xhigh"])?.effort).toBe("xhigh");
  expect(shiftEffort({ ...route, effort: "high" }, "lower", ["low", "high"])?.effort).toBe("low");
  expect(shiftEffort({ model: "m" }, "higher")).toEqual({ model: "m" });
});
