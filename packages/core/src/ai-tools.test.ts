import { expect, test } from "vitest";
import { allAiTools, BUILT_IN_AI_TOOLS, detectedAiTools, normalizeAiAssist, normalizeStepPlan, personAiTool, type StepPlan } from "./index";

test("the tools a plan assumes: the assistant always, coding agents seen in use, and what the person named — a named one wins its name", () => {
  expect(detectedAiTools(undefined)).toEqual([]);
  expect(detectedAiTools({ folders: [{ codex: 30, claude: 0 }, { codex: 0, claude: 12 }] }).map((tool) => tool.name)).toEqual(["Codex", "Claude Code"]);
  const capcut = personAiTool({ name: "剪映", kind: "media", goodFor: "自动字幕、粗剪" }, [])!;
  expect(capcut).toMatchObject({ id: "tool-剪映", kind: "media", by: "person", source: "person" });
  expect(personAiTool({ name: "  ", kind: "media", goodFor: "" }, [])).toBeUndefined();
  expect(personAiTool({ name: "X", kind: "nonsense", goodFor: "" }, ["tool-x"])).toMatchObject({ id: "tool-x-2", kind: "other" });
  const mine = { ...personAiTool({ name: "codex", kind: "coding", goodFor: "本人自己的用法" }, [])! };
  const all = allAiTools(JSON.stringify([capcut, mine]), detectedAiTools({ folders: [{ codex: 5, claude: 0 }] }));
  expect(all.slice(0, BUILT_IN_AI_TOOLS.length)).toEqual(BUILT_IN_AI_TOOLS);
  expect(all.filter((tool) => tool.name.toLowerCase() === "codex")).toEqual([expect.objectContaining({ source: "person", goodFor: "本人自己的用法" })]);
});

test("a step's assist names a tool the person has, says how, and cannot save more than the work could take", () => {
  expect(normalizeAiAssist({ tool: "剪映", how: "自动字幕后只校对专有名词", minutesSaved: 40 }, ["剪映"], 30)).toEqual({ tool: "剪映", how: "自动字幕后只校对专有名词", minutesSaved: 40 });
  expect(normalizeAiAssist({ tool: "Midjourney", how: "画封面", minutesSaved: 20 }, ["剪映"], 30)).toEqual({ tool: "", how: "", minutesSaved: 0 });
  expect(normalizeAiAssist({ tool: "剪映", how: "x", minutesSaved: 9999 }, ["剪映"], 30).minutesSaved).toBe(90);
  expect(normalizeAiAssist(undefined, ["剪映"], 30)).toEqual({ tool: "", how: "", minutesSaved: 0 });
});

test("normalizing a plan keeps each step's assist, checked against the person's tools", () => {
  const step = { id: "a", role: "solve", title: "推导 L5 例题", deliverable: "推导", doneCriterion: "推完", share: 1, estimate: { p25Minutes: 30, p50Minutes: 45, p85Minutes: 70 },
    dependsOn: [], notBefore: "", dueBy: "", schedulable: true, executor: "human", tickOutcome: "", covers: [], why: "",
    aiAssist: { tool: "ChatGPT", how: "让它出 5 道同难度题并隐藏答案", minutesSaved: 15 } } as const;
  const plan = { archetypeId: "problem_set", quantity: { basis: "题", amount: 5, unit: "题" }, rationale: "", units: [], questions: [], steps: [step, { ...step, id: "b", aiAssist: { tool: "Unknown", how: "x", minutesSaved: 5 } }] } as unknown as StepPlan;
  const { plan: normalized } = normalizeStepPlan(plan, ["ChatGPT"]);
  expect(normalized.steps.map((item) => item.aiAssist?.tool)).toEqual(["ChatGPT", ""]);
});
