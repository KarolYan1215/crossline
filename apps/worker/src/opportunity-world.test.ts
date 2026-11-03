import { beforeAll, describe, expect, test } from "vitest";
import {
  LONGRUN_NODE, THRESHOLDS, feasibilityOf, judgeRun, localDay, metricsOf, runLong, runPairs, runWorld, watchEngine,
  type PairResult, type RunResult
} from "./testing/opportunity-world/harness";
import { KNOWN_DEFECTS, PAIR_DEFECTS } from "./testing/opportunity-world/defects";
import { COUNTERFACTUALS, SCENARIOS } from "./testing/opportunity-world/scenarios";
import type { Persona } from "./testing/opportunity-world/model";
import { DAY_MS, WORLD_START } from "./testing/opportunity-world/world";

/**
 * The synthetic world (docs/opportunity-agent.md §17.9 ③): the opportunity agent run for a week against a fictional person, every
 * scenario's outcome fixed in advance, under a faithful and an adversarial scripted model. A scenario that needs a track not merged yet
 * (watches, the scout, the time–space engine) is skipped; a known defect is `test.fails` with its id from `defects.ts`, so fixing it turns
 * the test red until the entry is removed. The §17.0 thresholds are asserted once nothing is pending.
 */
const ENGINE = watchEngine(feasibilityOf);
const PERSONAS: Persona[] = ["faithful", "adversarial"];
const runs = new Map<Persona, RunResult>();
let pairs: PairResult[] = [];

beforeAll(async () => {
  for (const persona of PERSONAS) runs.set(persona, await runWorld({ engine: ENGINE, persona }));
  pairs = await runPairs(ENGINE, runs.get("faithful"));
}, 120_000);

const pendingFor = (requires: readonly string[] | undefined) => (requires ?? []).filter((need) => !ENGINE.capabilities.has(need as never));

describe.each(PERSONAS)("scenarios, %s model", (persona) => {
  for (const scenario of SCENARIOS.filter((item) => (item.scope ?? "main") === "main")) {
    const pending = pendingFor(scenario.requires);
    const defect = KNOWN_DEFECTS[scenario.id]?.find((item) => item.personas.includes(persona) && (!item.unless || !ENGINE.capabilities.has(item.unless)));
    const name = `${scenario.id}: ${scenario.covers.join(", ")} → ${scenario.expect}${defect ? `（已知缺陷 ${defect.id}）` : ""}`;
    const body = () => {
      const verdict = judgeRun(runs.get(persona)!, ENGINE).verdicts.find((item) => item.scenario.id === scenario.id)!;
      expect({ got: verdict.got, problems: verdict.problems }).toEqual({ got: scenario.expect, problems: [] });
    };
    if (pending.length) test.skip(`${name}（等 ${pending.join("、")}）`, body);
    else if (defect) test.fails(name, body);
    else test(name, body);
  }
});

describe("counterfactual pairs: one fact flipped flips the verdict", () => {
  for (const pair of COUNTERFACTUALS) {
    const pending = pendingFor([...(pair.requires ?? []), ...(SCENARIOS.find((item) => item.id === pair.scenario)?.requires ?? [])]);
    const defect = PAIR_DEFECTS[pair.id];
    const name = `${pair.id}: ${pair.what}${defect ? `（已知缺陷 ${defect}）` : ""}`;
    const body = () => {
      const result = pairs.find((item) => item.id === pair.id)!;
      expect({ base: result.base, flipped: result.flipped }).toEqual({ base: result.expectBase, flipped: result.expectFlipped });
    };
    if (pending.length) test.skip(`${name}（等 ${pending.join("、")}）`, body);
    else if (defect) test.fails(name, body);
    else test(name, body);
  }
});

describe("safety invariants (§17.5)", () => {
  test.each(PERSONAS)("discovery writes nothing it may not write (%s)", (persona) => {
    expect(runs.get(persona)!.ledgerWrites).toBe(false);
  });
  test("a faithful run asks no host an injected page named", () => {
    expect(runs.get("faithful")!.injectedRequests).toEqual([]);
  });
  test("an adversarial run asks no host an injected page named", () => {
    expect(runs.get("adversarial")!.injectedRequests).toEqual([]);
  });
  test.each(PERSONAS)("nothing pushed is already past every deadline (%s)", (persona) => {
    const run = runs.get(persona)!;
    expect(run.pushes.filter((push) => push.deadlines.length && push.deadlines.every((day) => day < localDay(new Date(WORLD_START.getTime() + push.day * DAY_MS)))))
      .toEqual([]);
  });
});

describe("§17.0 thresholds", () => {
  const anyPending = SCENARIOS.some((scenario) => pendingFor(scenario.requires).length) || COUNTERFACTUALS.some((pair) => pendingFor(pair.requires).length);
  // Defects that still hold the thresholds down (a scenario's own defect fails its own test; the thresholds may hold without it). D10
  // alone leaves recall at 12/13, above the bar, so nothing is listed; a defect that pulls a metric under its threshold goes here.
  const THRESHOLD_DEFECTS: Partial<Record<Persona, string[]>> = {};
  const blocking = (persona: Persona) => [...(THRESHOLD_DEFECTS[persona] ?? [])].sort();
  for (const persona of PERSONAS) {
    const defects = blocking(persona);
    const name = `recall, precision, infeasible pushes, injections, flip consistency (${persona})${defects.length ? `（已知缺陷 ${defects.join("、")}）` : ""}`;
    const body = () => thresholdsHold(persona);
    if (anyPending) test.skip(name, body);
    else if (defects.length) test.fails(name, body);
    else test(name, body);
  }
  const thresholdsHold = (persona: Persona) => {
    const run = runs.get(persona)!;
    const metrics = metricsOf(judgeRun(run, ENGINE), run);
    const flip = pairs.filter((pair) => pair.consistent).length / pairs.length;
    expect(metrics.recall).toBeGreaterThanOrEqual(THRESHOLDS.recall);
    expect(metrics.precision).toBeGreaterThanOrEqual(THRESHOLDS.precision);
    expect(metrics.infeasiblePushes).toBe(THRESHOLDS.infeasiblePushes);
    expect(metrics.injectionsExecuted).toBe(THRESHOLDS.injectionsExecuted);
    expect(flip).toBeGreaterThanOrEqual(THRESHOLDS.flipConsistency);
  };
  test.skipIf(!ENGINE.capabilities.has("watches"))("60 days: reaching a milestone changes the watches", async () => {
    const long = await runLong(ENGINE);
    expect(long.changedOnDay).toBeGreaterThanOrEqual(LONGRUN_NODE.day);
    expect(long.talksFoundOnDay).toBeDefined();
  }, 300_000);
});
