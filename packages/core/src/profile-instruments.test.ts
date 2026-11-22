import { describe, expect, test } from "vitest";
import {
  administrationNote, cardBank, cardsFor, facetScores, FACET_LABEL, instrumentScores, mergeInstrumentAnswers, neoPercentile, PROFILE_ITEMS,
  readInstrumentAnswers, readScaleAnswers, scaleAnswerLine, settledItems, type InstrumentAnswers, type ItemAnswer
} from "./profile-instruments";
import { SCHWARTZ_VALUES } from "./portrait";
import { claimPrivacy, claimProblem, readPrivacyChoices, visibleClaims, type ProfileClaim } from "./profile-report";

const at = "2026-11-22T10:00:00.000Z";
const tap = (itemId: string, score: number): ItemAnswer => ({ itemId, score, by: "tapped", at });
const map = (itemId: string, score: number): ItemAnswer => ({ itemId, score, by: "mapped", confidence: 0.7, refs: [3], at });
const all = (instrument: string, score: number | ((id: string) => number)) =>
  Object.fromEntries(PROFILE_ITEMS.filter((item) => item.instrument === instrument)
    .map((item) => [item.id, tap(item.id, typeof score === "number" ? score : score(item.id))])) as InstrumentAnswers;
const item = (id: string) => PROFILE_ITEMS.find((candidate) => candidate.id === id)!;

describe("the item bank (IPIP-NEO-120 and TwIVI, 2026-11-22)", () => {
  test("holds Johnson's 120 items, 24 per domain and 4 per facet, and TwIVI's 20 portraits, two per Schwartz value", () => {
    const neo = PROFILE_ITEMS.filter((entry) => entry.instrument === "ipip_neo_120");
    expect(neo).toHaveLength(120);
    for (const domain of ["N", "E", "O", "A", "C"]) expect(neo.filter((entry) => entry.dimension === domain)).toHaveLength(24);
    for (const facet of Object.keys(FACET_LABEL)) expect(neo.filter((entry) => entry.facet === facet)).toHaveLength(4);
    expect(Object.keys(FACET_LABEL)).toHaveLength(30);
    // The order cycles N E O A C, facets one to six (Johnson 2014).
    expect(neo.slice(0, 6).map((entry) => entry.facet)).toEqual(["N1", "E1", "O1", "A1", "C1", "N2"]);
    // Spot checks against the published key: 「Use others for my own ends」 is A2 minus, 「Worry about things」 N1 plus, 「Act without thinking」 C6 minus.
    expect(item("neo-9")).toMatchObject({ facet: "A2", reverse: true, en: "Use others for my own ends", points: 5 });
    expect(item("neo-1")).toMatchObject({ facet: "N1", reverse: false });
    expect(item("neo-120")).toMatchObject({ facet: "C6", reverse: true });
    expect(neo.filter((entry) => entry.reverse)).toHaveLength(55);
    const twivi = PROFILE_ITEMS.filter((entry) => entry.instrument === "twivi");
    expect(twivi).toHaveLength(20);
    for (const value of SCHWARTZ_VALUES) expect(twivi.filter((entry) => entry.dimension === value.name)).toHaveLength(2);
    expect(twivi.every((entry) => entry.points === 6 && !entry.reverse)).toBe(true);
    // Items 1 and 11 measure conformity, 10 and 20 security (Sandy et al.'s key).
    expect([item("twivi-1").dimension, item("twivi-11").dimension, item("twivi-10").dimension, item("twivi-20").dimension]).toEqual(["遵从", "遵从", "安全", "安全"]);
    expect(new Set(PROFILE_ITEMS.map((entry) => entry.id)).size).toBe(140);
    expect(PROFILE_ITEMS.every((entry) => entry.text && entry.en)).toBe(true);
  });

  test("the interview asks no cards any more: the scale is a page of its own", () => {
    expect(cardsFor("compass", new Set())).toEqual([]);
    expect(cardBank("short")).toEqual([]);
    expect(cardBank("all")).toBe(PROFILE_ITEMS);
  });
});

describe("answers", () => {
  test("a TwIVI item takes six points, an IPIP item five; the tap line round-trips", () => {
    const kept = mergeInstrumentAnswers({}, [tap("twivi-6", 6), tap("neo-1", 6), tap("neo-2", 5), tap("ghost", 3)]);
    expect(Object.keys(kept).sort()).toEqual(["neo-2", "twivi-6"]);
    expect(scaleAnswerLine(item("twivi-6"), 6)).toBe("【Ta 喜欢冒险，总在寻找新的历险。】点选：6/6（非常像我）");
    expect(readScaleAnswers([scaleAnswerLine(item("twivi-6"), 6), scaleAnswerLine(item("neo-1"), 2), "【其他】点选：3/5"].join("\n"), ["twivi-6", "neo-1"], at))
      .toEqual([tap("twivi-6", 6), tap("neo-1", 2)]);
  });

  test("the person's tap is never replaced by a mapping, and a skip never replaces an answer; old card answers are not read", () => {
    let kept = mergeInstrumentAnswers({}, [tap("neo-1", 4), map("neo-6", 2), { itemId: "neo-11", by: "skipped", at }]);
    kept = mergeInstrumentAnswers(kept, [map("neo-1", 1), { itemId: "neo-6", by: "skipped", at }, map("neo-11", 5)]);
    expect(kept["neo-1"]).toEqual(tap("neo-1", 4));
    expect(kept["neo-6"]).toEqual(map("neo-6", 2));
    expect(kept["neo-11"]).toEqual(map("neo-11", 5));
    expect(settledItems(kept).has("neo-11")).toBe(true);
    // The 43-item cards' answers (`ipip-1`, `value-2`) of an older ledger are not items any more.
    expect(readInstrumentAnswers(JSON.stringify({ ...kept, "ipip-1": tap("ipip-1", 3), "value-2": tap("value-2", 1) }))).toEqual(kept);
    expect(readInstrumentAnswers("not json")).toEqual({});
  });
});

describe("scores", () => {
  test("reverse keys are applied per facet: agreeing with all four E1 items sums to the middle, a consistent answer to the top", () => {
    const e1 = PROFILE_ITEMS.filter((entry) => entry.facet === "E1");
    const agree = mergeInstrumentAnswers({}, e1.map((entry) => tap(entry.id, 5)));
    expect(facetScores(agree).find((facet) => facet.facet === "E1")).toMatchObject({ sum: 12, answered: 4 });
    const friendly = mergeInstrumentAnswers({}, e1.map((entry) => tap(entry.id, entry.reverse ? 1 : 5)));
    expect(facetScores(friendly).find((facet) => facet.facet === "E1")).toMatchObject({ sum: 20, percentile: neoPercentile("E1", 20) });
  });

  test("a facet with one item missing is prorated, with two it has no score, and its domain none either", () => {
    const n1 = PROFILE_ITEMS.filter((entry) => entry.facet === "N1");
    const three = mergeInstrumentAnswers({}, n1.slice(0, 3).map((entry) => tap(entry.id, 4)));
    expect(facetScores(three).find((facet) => facet.facet === "N1")!.sum).toBe(16);
    const two = mergeInstrumentAnswers({}, [...n1.slice(0, 2).map((entry) => tap(entry.id, 4)), { itemId: n1[2]!.id, by: "skipped" as const, at }, { itemId: n1[3]!.id, by: "skipped" as const, at }]);
    expect(facetScores(two).find((facet) => facet.facet === "N1")!.sum).toBeNull();
    const domains = instrumentScores({ ...all("ipip_neo_120", 3), ...two }, "ipip_neo_120");
    expect(domains.find((score) => score.dimension === "N")!.score).toBeNull();
    expect(domains.find((score) => score.dimension === "E")).toMatchObject({ raw: 12, percentile: neoPercentile("E", 12), tapped: 24 });
    expect(administrationNote(domains.find((score) => score.dimension === "N")!)).toBe("22 题点选、2 题跳过");
  });

  test("percentiles read against the published norm: the norm's mean is the 50th, a standard deviation up about the 84th", () => {
    expect(neoPercentile("N", 11.10)).toBe(50);
    expect(neoPercentile("C2", 13.23 + 4.31)).toBe(84);
    expect(neoPercentile("O", 4)).toBe(1);
    expect(neoPercentile("O", 20)).toBe(99);
    expect(neoPercentile("X9", 12)).toBeNull();
  });

  test("TwIVI: a value is the mean of its two items, centred on the person's own mean, and ranked among the ten", () => {
    // Stimulation (6, 16) high, power (9, 19) low, everything else 3: the person's mean is 3.1.
    const answers = all("twivi", (id) => ["twivi-6", "twivi-16"].includes(id) ? 6 : ["twivi-9", "twivi-19"].includes(id) ? 1 : 3);
    const scores = instrumentScores(answers, "twivi");
    const of = (name: string) => scores.find((score) => score.dimension === name)!;
    expect(scores).toHaveLength(10);
    expect(of("刺激")).toMatchObject({ raw: 6, rank: 1, centered: 2.9 });
    expect(of("权力")).toMatchObject({ raw: 1, rank: 10, centered: -2.1 });
    expect(of("仁慈")).toMatchObject({ raw: 3, centered: -0.1 });
    // Fewer than 16 of the 20 answered: values are scored, but not centred.
    const few = mergeInstrumentAnswers({}, [tap("twivi-6", 6), tap("twivi-16", 5)]);
    expect(instrumentScores(few, "twivi").find((score) => score.dimension === "刺激")).toMatchObject({ raw: 5.5, rank: 1 });
    expect(instrumentScores(few, "twivi").find((score) => score.dimension === "刺激")!.centered).toBeUndefined();
  });
});

describe("claims and privacy", () => {
  const claim = (over: Partial<ProfileClaim>): ProfileClaim => ({
    id: "c1", section: "personality", statement: "做事讲次序", kind: "inferred", confidence: 0.6,
    basis: [{ sentenceId: 12, quote: "我每天先列清单" }], ...over
  });

  test("a claim needs a statement, a basis, a measure when measured and a window when observed", () => {
    expect(claimProblem(claim({}))).toBeNull();
    expect(claimProblem(claim({ basis: [] }))).toBe("CLAIM_BASIS_MISSING");
    expect(claimProblem(claim({ kind: "measured" }))).toBe("CLAIM_MEASURE_MISSING");
    expect(claimProblem(claim({ kind: "measured", basis: [{ instrument: "ipip_neo_120", items: ["neo-5"], administration: "tapped" }] }))).toBeNull();
    expect(claimProblem(claim({ kind: "observed", basis: [{ behaviour: "准时交付", window: "" }] }))).toBe("CLAIM_WINDOW_MISSING");
    expect(claimProblem(claim({ confidence: 1.2 }))).toBe("CLAIM_CONFIDENCE_RANGE");
  });

  test("the claim's own level wins over the section's, and each audience sees its level and below", () => {
    const claims = [claim({ id: "a" }), claim({ id: "b", section: "tensions" }), claim({ id: "c", section: "overview" }), claim({ id: "d", privacy: "private" })];
    expect(visibleClaims(claims, "agent").map((item) => item.id)).toEqual(["a", "c"]);
    expect(visibleClaims(claims, "public").map((item) => item.id)).toEqual(["c"]);
    const choices = readPrivacyChoices(JSON.stringify({ sections: { personality: "public", bogus: "public" }, claims: { c: "private", x: "loud" } }));
    expect(choices).toEqual({ sections: { personality: "public" }, claims: { c: "private" } });
    expect(claimPrivacy(claims[0]!, choices)).toBe("public");
    expect(visibleClaims(claims, "public", choices).map((item) => item.id)).toEqual(["a"]);
  });
});
