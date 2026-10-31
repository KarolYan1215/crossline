import { describe, expect, test } from "vitest";
import {
  administrationNote, cardsFor, cardsSettled, cardWordsHead, instrumentScores, mergeInstrumentAnswers, pendingItems, PROFILE_ITEMS,
  readCardAnswers, readInstrumentAnswers, readScaleAnswers, scaleAnswerLine, settledItems, type InstrumentAnswers, type ItemAnswer
} from "./profile-instruments";
import { SCHWARTZ_VALUES } from "./portrait";
import { claimPrivacy, claimProblem, readPrivacyChoices, visibleClaims, type ProfileClaim } from "./profile-report";

const at = "2026-10-31T10:00:00.000Z";
const tap = (itemId: string, score: number): ItemAnswer => ({ itemId, score, by: "tapped", at });
const map = (itemId: string, score: number): ItemAnswer => ({ itemId, score, by: "mapped", confidence: 0.7, refs: [3], at });
const all = (instrument: string, score: number, by: (id: string, score: number) => ItemAnswer = tap) =>
  Object.fromEntries(PROFILE_ITEMS.filter((item) => item.instrument === instrument).map((item) => [item.id, by(item.id, score)])) as InstrumentAnswers;

describe("the item bank", () => {
  test("holds Mini-IPIP's 20 items four per domain with the published reverse keys, 18REST's two per type, SWLS's five and six value pairs", () => {
    const ipip = PROFILE_ITEMS.filter((item) => item.instrument === "mini_ipip");
    expect(ipip).toHaveLength(20);
    for (const domain of ["E", "A", "C", "N", "O"]) expect(ipip.filter((item) => item.dimension === domain)).toHaveLength(4);
    expect(ipip.filter((item) => item.reverse).map((item) => Number(item.id.slice(5))).sort((a, b) => a - b))
      .toEqual([6, 7, 8, 9, 10, 15, 16, 17, 18, 19, 20]);
    const rest = PROFILE_ITEMS.filter((item) => item.instrument === "rest18");
    expect(rest).toHaveLength(12);
    for (const type of ["R", "I", "A", "S", "E", "C"]) expect(rest.filter((item) => item.dimension === type)).toHaveLength(2);
    expect(PROFILE_ITEMS.filter((item) => item.instrument === "swls")).toHaveLength(5);
    const named = new Set(PROFILE_ITEMS.filter((item) => item.instrument === "values").flatMap((item) => item.dimension.split("|")));
    expect([...named].sort()).toEqual(SCHWARTZ_VALUES.map((value) => value.name).sort());
    expect(new Set(PROFILE_ITEMS.map((item) => item.id)).size).toBe(PROFILE_ITEMS.length);
  });
});

describe("cards", () => {
  test("a round offers at most three items, at most three a card, one instrument each, and never an item already answered or skipped", () => {
    const first = cardsFor("compass", new Set());
    expect(first.map((card) => [card.instrument, card.items.length])).toEqual([["mini_ipip", 3]]);
    const settled = new Set([...first.flatMap((card) => card.items.map((item) => item.id))]);
    const next = cardsFor("compass", settled);
    expect(next.map((card) => card.instrument)).toEqual(["mini_ipip", "values"]);
    expect(next.flatMap((card) => card.items)).toHaveLength(3);
    expect(next.flatMap((card) => card.items).some((item) => settled.has(item.id))).toBe(false);
    const done = new Set(PROFILE_ITEMS.filter((item) => item.stage === "compass").map((item) => item.id));
    expect(cardsFor("compass", done)).toEqual([]);
  });

  test("items a stage never got to come first in a later stage, and never share a card with the later stage's", () => {
    const narrative = new Set(PROFILE_ITEMS.filter((item) => item.stage === "narrative").map((item) => item.id));
    const leftOver = [...narrative].pop()!;
    const settled = new Set([...narrative].filter((id) => id !== leftOver));
    const cards = cardsFor(["narrative", "compass"], settled);
    expect(cards[0]!.items.map((item) => item.id)).toEqual([leftOver]);
    expect(cards[0]!.stage).toBe("narrative");
    expect(cards[1]!.stage).toBe("compass");
    expect(cardsFor(["narrative", "compass"], settled, 1)).toHaveLength(1);
    expect(cardsSettled(settled)).toEqual({ settled: narrative.size - 1, total: PROFILE_ITEMS.length });
  });
});

describe("answers", () => {
  test("a tap is read straight out of the reply, and only for items the round offered", () => {
    const item = PROFILE_ITEMS.find((candidate) => candidate.id === "ipip-1")!;
    const pair = PROFILE_ITEMS.find((candidate) => candidate.id === "value-2")!;
    const reply = [scaleAnswerLine(item, 4), scaleAnswerLine(pair, 1), "【其他】选择：A", "【随便】点选：3/5"].join("\n");
    expect(scaleAnswerLine(pair, 1)).toContain("（去试新鲜、有挑战的事）");
    // 2 and 4 say which pole they lean to, so a value is never read the wrong way round.
    expect(scaleAnswerLine(pair, 2)).toMatch(new RegExp(`点选：2/5（偏向「${pair.anchors[0]}」）$`));
    expect(scaleAnswerLine(pair, 4)).toMatch(new RegExp(`点选：4/5（偏向「${pair.anchors[2]}」）$`));
    expect(readScaleAnswers(scaleAnswerLine(pair, 4), ["value-2"], at)).toEqual([tap("value-2", 4)]);
    expect(readScaleAnswers(reply, ["ipip-1", "value-2"], at)).toEqual([tap("ipip-1", 4), tap("value-2", 1)]);
    expect(readScaleAnswers(reply, ["value-2"], at)).toEqual([tap("value-2", 1)]);
  });

  test("a card's taps are scores, words in its box wait for the extraction, and a card passed over is skipped", () => {
    const [first] = cardsFor("compass", new Set());
    const [second] = cardsFor("compass", new Set(first!.items.map((item) => item.id)));
    const [a, b, c] = first!.items;
    const reply = [scaleAnswerLine(a!, 2), `${cardWordsHead(first!)}：看场合，一般不太主动`, "其他回答"].join("\n");
    const answers = readCardAnswers(reply, [first!, second!], at);
    expect(answers).toEqual([tap(a!.id, 2), { itemId: b!.id, by: "pending", at }, { itemId: c!.id, by: "pending", at },
      ...second!.items.map((item) => ({ itemId: item.id, by: "skipped", at }))]);
    // A turn that answers nothing of the round (a file added) leaves the cards for later.
    expect(readCardAnswers("我添加了这些文件：a.pdf。", [first!, second!], at)).toEqual([]);
    // A bare head with nothing after it says nothing.
    expect(readCardAnswers(cardWordsHead(first!), [first!], at).filter((answer) => answer.by === "pending")).toEqual([]);
    const kept = mergeInstrumentAnswers({}, answers);
    expect(pendingItems(kept).map((item) => item.id)).toEqual([b!.id, c!.id]);
    // The extraction's mapping replaces the pending answer; a later skip does not undo the mapping.
    const mapped = mergeInstrumentAnswers(kept, [map(b!.id, 2), { itemId: c!.id, by: "skipped", at }]);
    expect(mapped[b!.id]).toEqual(map(b!.id, 2));
    expect(mapped[c!.id]).toEqual({ itemId: c!.id, by: "pending", at });
  });

  test("the person's tap is never replaced by a mapping, and a skip never replaces an answer", () => {
    let kept = mergeInstrumentAnswers({}, [tap("ipip-1", 4), map("ipip-6", 2), { itemId: "ipip-11", by: "skipped", at }]);
    kept = mergeInstrumentAnswers(kept, [map("ipip-1", 1), { itemId: "ipip-6", by: "skipped", at }, map("ipip-11", 5), tap("nope", 3), tap("ipip-16", 9)]);
    expect(kept["ipip-1"]).toEqual(tap("ipip-1", 4));
    expect(kept["ipip-6"]).toEqual(map("ipip-6", 2));
    expect(kept["ipip-11"]).toEqual(map("ipip-11", 5));
    expect(Object.keys(kept).sort()).toEqual(["ipip-1", "ipip-11", "ipip-6"]);
    expect(settledItems(kept).has("ipip-11")).toBe(true);
    expect(readInstrumentAnswers(JSON.stringify({ ...kept, ghost: tap("ghost", 1) }))).toEqual(kept);
    expect(readInstrumentAnswers("not json")).toEqual({});
  });
});

describe("scores", () => {
  test("reverse keys are applied: agreeing with every extraversion item lands in the middle, a consistent extravert at the top", () => {
    const flat = instrumentScores(all("mini_ipip", 5), "mini_ipip").find((score) => score.dimension === "E")!;
    expect(flat.score).toBe(50);
    const extravert = mergeInstrumentAnswers({}, [tap("ipip-1", 5), tap("ipip-6", 1), tap("ipip-11", 5), tap("ipip-16", 1)]);
    const e = instrumentScores(extravert, "mini_ipip").find((score) => score.dimension === "E")!;
    expect(e).toMatchObject({ label: "外向性", score: 100, tapped: 4, mapped: 0, administration: "tapped" });
    expect(instrumentScores(extravert, "mini_ipip").find((score) => score.dimension === "A")!.score).toBeNull();
  });

  test("a dimension with more than half mapped, or one skipped item, gets no number; half mapped still does", () => {
    const halfMapped = mergeInstrumentAnswers({}, [tap("ipip-1", 4), tap("ipip-6", 2), map("ipip-11", 4), map("ipip-16", 2)]);
    const half = instrumentScores(halfMapped, "mini_ipip").find((score) => score.dimension === "E")!;
    expect(half).toMatchObject({ score: 75, administration: "mixed" });
    expect(administrationNote(half)).toBe("2 题点选、2 题由文字折算");
    const mostly = mergeInstrumentAnswers({}, [tap("ipip-1", 4), map("ipip-6", 2), map("ipip-11", 4), map("ipip-16", 2)]);
    expect(instrumentScores(mostly, "mini_ipip").find((score) => score.dimension === "E")!.score).toBeNull();
    const skipped = mergeInstrumentAnswers({}, [tap("ipip-1", 4), tap("ipip-6", 2), tap("ipip-11", 4), { itemId: "ipip-16", by: "skipped", at }]);
    const s = instrumentScores(skipped, "mini_ipip").find((score) => score.dimension === "E")!;
    expect(s.score).toBeNull();
    expect(administrationNote(s)).toBe("3 题点选、1 题跳过");
  });

  test("a value pair scores both of its values from one answer, and a value in two pairs averages them", () => {
    const answers = mergeInstrumentAnswers({}, [tap("value-2", 1), tap("value-6", 5)]);
    const scores = Object.fromEntries(instrumentScores(answers, "values").map((score) => [score.dimension, score.score]));
    expect(scores["刺激"]).toBe(100);
    // 安全 loses value-2 fully (0) and value-6 fully (0): the person leaned to 刺激 and 自主.
    expect(scores["安全"]).toBe(0);
    expect(scores["自主"]).toBeNull();
    expect(instrumentScores(answers, "values")).toHaveLength(10);
  });

  test("SWLS is one dimension of five items", () => {
    expect(instrumentScores(all("swls", 4), "swls")).toEqual([expect.objectContaining({ dimension: "swls", label: "生活满意度", score: 75, items: 5 })]);
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
    expect(claimProblem(claim({ kind: "measured", basis: [{ instrument: "mini_ipip", items: ["ipip-3"], administration: "tapped" }] }))).toBeNull();
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
