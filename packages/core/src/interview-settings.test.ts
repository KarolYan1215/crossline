import { expect, test } from "vitest";
import { inQuiet, mergeInterviewSettings, parseQuiet, quietHoursOf, readInterviewSettings, settingProblem } from "./index";

const refs = { milestones: new Set<string>(), tasks: new Set<string>(), lines: new Set<string>() };
const said = (key: string, value: string, target = "") => ({ key, target, value, quote: "原话", sourceRef: "reply-3" });

test("quiet hours may run past midnight; equal ends mean none; the default is 23:00–08:00", () => {
  expect(parseQuiet("22:30-09:30")).toEqual({ from: "22:30", to: "09:30" });
  expect(parseQuiet("22:30–09:30")).toEqual({ from: "22:30", to: "09:30" });
  expect(parseQuiet("25:00-09:00")).toBeUndefined();
  const quiet = quietHoursOf("22:30-09:30");
  expect([inQuiet("23:00", quiet), inQuiet("09:00", quiet), inQuiet("09:30", quiet), inQuiet("12:00", quiet)]).toEqual([true, true, false, false]);
  expect(inQuiet("12:00", { from: "12:00", to: "14:00" })).toBe(true);
  expect(inQuiet("03:00", { from: "08:00", to: "08:00" })).toBe(false);
  expect(quietHoursOf(undefined)).toEqual({ from: "23:00", to: "08:00" });
});

test("the catalog checks a clock and a range", () => {
  expect(settingProblem({ key: "notify.briefTime", target: "", value: "09:40" }, refs)).toBe("");
  expect(settingProblem({ key: "notify.briefTime", target: "", value: "" }, refs)).toBe("");
  expect(settingProblem({ key: "notify.briefTime", target: "", value: "9点40" }, refs)).not.toBe("");
  expect(settingProblem({ key: "notify.quietHours", target: "", value: "22:30-09:30" }, refs)).toBe("");
  expect(settingProblem({ key: "notify.quietHours", target: "", value: "晚上" }, refs)).not.toBe("");
});

test("interview settings: invalid and unsupported ones are dropped, a later statement replaces an earlier one and comes back pending", () => {
  const first = mergeInterviewSettings([], [said("notify.quietHours", "22:30-09:30"), said("schedule.focusCapMinutes", "500"),
    said("consent.camera", "on"), said("agent.category", "on", "read_research_organize"), said("agent.category", "on", "nonsense"),
    { ...said("notify.level", "less"), sourceRef: "" }], "2026-10-30T00:00:00Z", refs);
  expect(first.map((item) => `${item.key}|${item.target}|${item.value}|${item.state}`))
    .toEqual(["notify.quietHours||22:30-09:30|pending", "agent.category|read_research_organize|on|pending"]);
  const applied = first.map((item) => ({ ...item, state: "applied" as const }));
  const again = mergeInterviewSettings(applied, [said("notify.quietHours", "22:30-09:30"), said("notify.quietHours", "23:00-09:00")], "2026-10-30T01:00:00Z", refs);
  expect(again.find((item) => item.key === "notify.quietHours")).toMatchObject({ value: "23:00-09:00", state: "pending" });
  expect(again.find((item) => item.key === "agent.category")?.state).toBe("applied");
  expect(readInterviewSettings(JSON.stringify(again))).toHaveLength(2);
  expect(readInterviewSettings("not json")).toEqual([]);
});

test("the night the person stated becomes the energy curve's usual night until one is recorded", async () => {
  const { statedSleep } = await import("./energy-rhythm");
  const fact = (value: string, status = "confirmed") => [{ identityId: "person", slot: "sleep_window", status, value }];
  expect(statedSleep(fact("01:00-09:00"))).toEqual({ from: 25, to: 9 });
  expect(statedSleep(fact("23:30-07:30"))).toEqual({ from: 23.5, to: 7.5 });
  expect(statedSleep(fact("01:00-09:00", "inferred"))).toBeUndefined();
  expect(statedSleep(fact("一点睡"))).toBeUndefined();
});
