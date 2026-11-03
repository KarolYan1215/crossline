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
 * (`packages/core/src/feasibility.ts`); and D11 (nothing filled `Opportunity.place`), by track ①: the reader gives `place` with a quote
 * checked against the page, and `opportunityFromRead` derives one from a `location` line whose city is on the page.
 */
export type Defect = { id: string; owner: string; where: string; what: string };

export const DEFECTS: Defect[] = [];

/** Scenario id → the defects that make it fail, for which personas; `unless` drops the entry once that capability is there. */
export const KNOWN_DEFECTS: Record<string, Array<{ id: string; personas: Persona[]; unless?: Capability }>> = {};

export const PAIR_DEFECTS: Record<string, string> = {};
