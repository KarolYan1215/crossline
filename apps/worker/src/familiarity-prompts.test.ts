import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { FAMILIARITY_INSTRUCTIONS } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { createStepPlanner } from "./step-planner";
import { buildManualContext } from "./manualbook";
import { scriptedRuntime } from "./testing/fake-runtime";

/**
 * Walkthrough W-154: detail follows how close the work is to what the person knows. The step planner, the tutorial designer and the
 * writer are each told the level and what it means; this holds the prompts to it.
 */
const ws = "w", owner = "o";
const skill = (name: string) => readFileSync(path.resolve(import.meta.dirname, `../../../skills/marketplace/plugins/crossline/skills/${name}/SKILL.md`), "utf8");

function seed() {
  const store = new CrosslineStore(":memory:");
  store.saveMilestone({ id: "m", ownerId: owner, workspaceId: ws, identityId: "media", projectId: "xhs", title: "首轮发布", status: "approved", version: 1 });
  store.saveWorkOrder({ id: "wo", ownerId: owner, workspaceId: ws, identityId: "media", projectId: "xhs", milestoneId: "m", intent: "选定首轮选题",
    state: "approved", riskTier: "routine", estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 60, source: "llm_prior", observationCount: 0, confidence: "low" },
    payload: { family: "deep_work" } });
  store.upsertProfileFact({ workspaceId: ws, identityId: "media", projectId: "", slot: "stage", value: "完全是新手，第一次做内容", status: "confirmed",
    sourceRef: "reply-1", sourceQuote: "完全是新手", updatedAt: "2026-10-01T00:00:00Z" });
  return store;
}

test("the step planner is told the familiarity level and what it means", async () => {
  const store = seed();
  const plan = { archetypeId: "content", quantity: { basis: "选题", amount: 3, unit: "个" }, rationale: "", steps: [{ id: "s", role: "decide", title: "选定首轮三个选题",
    deliverable: "选题表", doneCriterion: "每个选题标出受众与冲突点", share: 1, estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45 }, dependsOn: [],
    notBefore: "", dueBy: "", schedulable: true, executor: "human", tickOutcome: "" }] };
  const runtime = scriptedRuntime(["crossline:crossline-step-planner"], () => JSON.stringify(plan));
  await createStepPlanner(store, ws, "C:\\repo", () => runtime.rpc)("wo");
  const prompt = runtime.prompts().join("\n");
  expect(prompt).toContain("\"familiarity\":{\"level\":\"far\"");
  store.close();
});

test("the tutorial's design and its sections carry the level", () => {
  const store = seed();
  expect(buildManualContext(store, ws, "wo", "2026-10-29")?.familiarity?.level).toBe("far");
  store.close();
});

test("the Skills say what near and far mean, and the shared sentence names both ends", () => {
  for (const name of ["crossline-step-planner", "crossline-material-writer", "crossline-manualbook-designer"]) {
    const text = skill(name);
    expect(text).toContain("familiarity");
    expect(text).toMatch(/`near`/);
    expect(text).toMatch(/`far`/);
  }
  expect(FAMILIARITY_INSTRUCTIONS).toMatch(/near:.*far:/s);
  // Near work never points at a general authoritative guide (the NASA / MIT design-review guides the owner was handed).
  expect(skill("crossline-material-writer")).toMatch(/NASA or MIT/);
});
