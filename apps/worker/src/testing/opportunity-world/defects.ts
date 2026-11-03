import type { Capability } from "./scenarios";
import type { Persona } from "./model";

/**
 * Real defects the synthetic world found in the code it runs (§17.9 ③), each with the scenario that shows it and the track that owns
 * the fix. The suite marks the affected tests `test.fails`; a fix makes them pass, the test turns red, and the entry here is removed. Fixed
 * so far: D8 (a reached milestone did not re-derive the watches), by track ①'s 「按节点重推」 (`watchesDeriveDue` reads milestone events); by
 * track ① on 2026-11-02: D1 (every search target, `SEARCHES_PER_RUN`), D2 and D9 (citizenship and region compared by country key, an
 * EU/EEA group, clauses that restrict nothing and 「any STEM」 read by rule), D3 (a title's 「'26」 is its year), D4 (a quote naming another
 * year is not that day; a past round is `earlier_cycle`), D5 (`phishingSigns`), D6 (hidden elements dropped by `htmlToText`, a hit
 * quoting text not on the page read again from the page, no request to an address carrying the person's name or email) and D7 (a moved
 * deadline read as its new day); and D10 (a TBD date read as a deadline of today, so never pushed), by track ②'s `dateUnconfirmed`
 * (`packages/core/src/feasibility.ts`).
 */
export type Defect = { id: string; owner: string; where: string; what: string };

export const DEFECTS: Defect[] = [
  // Found in the final acceptance (2026-11-02), once the harness stopped reading a place out of `location` for the engine.
  { id: "D11", owner: "①（A 线读取，§17.6 「活动在哪里由读取器抽取」）", where: "OPPORTUNITY_READING_SCHEMA 只有 `location` 字符串；opportunityFromRead 不写 `Opportunity.place`",
    what: "生产里没有任何代码填 `place`，`feasibilityNow` 读不到就当地点未知：不查签证、不算路程，签证来不及（温哥华会议）和超出半径（芝加哥活动）照推，"
      + "卡片也不显示路程与签证；翻转对住处、行程、签证三对不翻。测试台此前从 `location` 自己推地点，把它盖住了。" }
];

/** Scenario id → the defects that make it fail, for which personas; `unless` drops the entry once that capability is there. */
export const KNOWN_DEFECTS: Record<string, Array<{ id: string; personas: Persona[]; unless?: Capability }>> = {
  "visa-too-late": [{ id: "D11", personas: ["faithful", "adversarial"] }],
  "beyond-radius": [{ id: "D11", personas: ["faithful", "adversarial"] }]
};

export const PAIR_DEFECTS: Record<string, string> = { "cf-home": "D11", "cf-trip": "D11", "cf-visa": "D11" };
