import { describe, expect, test } from "vitest";
import { QUIZ_ITEMS, quizScores } from "./assess";
import { LINE_IDENTITIES, RELATIONS, TYPE_CODES, TYPE_LINES, TYPE_SUBTITLE, axisRank, isAmbiguous, shownRank, pairFit, partnersOf, relationOf } from "./assess-content";
import { TYPE_AXES } from "./portrait-type";

describe("the thirty-two questions", () => {
  test("eight per dimension, ids unique, neighbours never on one dimension", () => {
    expect(QUIZ_ITEMS).toHaveLength(32);
    expect(new Set(QUIZ_ITEMS.map((item) => item.id)).size).toBe(32);
    for (const axis of TYPE_AXES) expect(QUIZ_ITEMS.filter((item) => item.axis === axis.id)).toHaveLength(8);
    QUIZ_ITEMS.slice(1).forEach((item, index) => expect(item.axis).not.toBe(QUIZ_ITEMS[index]!.axis));
  });
  test("statements are positively worded: no negation and no 「比起」 comparison inside a statement", () => {
    for (const item of QUIZ_ITEMS.filter((entry) => entry.kind === "pole")) expect(item.text, item.id).not.toMatch(/不会|从不|并不|比起/);
  });
  test("all neutral reads just under the middle on every dimension, decided left", () => {
    expect(Object.values(quizScores(Object.fromEntries(QUIZ_ITEMS.map((item) => [item.id, 3]))))).toEqual([49, 49, 49, 49]);
  });
});

describe("type content", () => {
  test("every type has a subtitle, three lines and a four-step loop", () => {
    expect(TYPE_CODES).toHaveLength(16);
    for (const code of TYPE_CODES) {
      expect(TYPE_SUBTITLE[code]!.length).toBeGreaterThan(4);
      expect(TYPE_LINES[code]!.lines).toHaveLength(3);
      expect(TYPE_LINES[code]!.loop).toHaveLength(4);
      // The poster's loop boxes hold ten characters on one line; an identity runs at most twelve beside it.
      for (const step of TYPE_LINES[code]!.loop) expect([...step].length, step).toBeLessThanOrEqual(10);
      // Four combinations of three lines from the vocabulary; within a type the twelve identities never repeat; a field runs at most
      // seven characters, and a licensed profession stands alone with none.
      const all = [TYPE_LINES[code]!.lines, ...TYPE_LINES[code]!.more];
      expect(all).toHaveLength(4);
      for (const combo of all) {
        expect(combo).toHaveLength(3);
        for (const line of combo) {
          expect(LINE_IDENTITIES, line.identity).toContain(line.identity);
          expect([...line.domain].length, line.domain).toBeLessThanOrEqual(7);
          if (["医生", "律师", "中医师"].includes(line.identity)) expect(line.domain).toBe("");
          else expect(line.domain, line.identity).not.toBe("");
        }
      }
      expect(new Set(all.flat().map((line) => line.identity)).size, code).toBe(12);
      expect(all.flat().some((line) => /行业$/.test(line.domain) && line.identity === "职场人" && /医疗|法律|中医/.test(line.domain))).toBe(false);
    }
  });
});

describe("relations", () => {
  test("every one of the 256 pairs has a relation, the same both ways", () => {
    for (const a of TYPE_CODES) for (const b of TYPE_CODES) {
      const ab = relationOf(a, b), ba = relationOf(b, a);
      expect(ab.primary.id).toBe(ba.primary.id);
      expect(ab.secondary?.id).toBe(ba.secondary?.id);
    }
  });
  test("the same type is a twin, none alike mirrors, one letter apart names the difference first and twin second", () => {
    expect(relationOf("CLWU", "CLWU").primary.id).toBe("twin");
    expect(relationOf("CLWU", "CLWV")).toMatchObject({ primary: { id: "pace" }, secondary: { id: "twin" } });
    expect(relationOf("CLWU", "CXWU")).toMatchObject({ primary: { id: "explore_exploit" }, secondary: { id: "twin" } });
    expect(relationOf("CLWU", "DXBV").primary.id).toBe("mirror");
    expect(relationOf("DXWV", "CXBV").primary.id).toBe("rabbit_holes");
    expect(relationOf("CLWU", "DLBU").primary.id).toBe("double_safe");
    expect(relationOf("CLWU", "CLBV").primary.id).toBe("pace");
    expect(relationOf("CLWV", "CLBV")).toMatchObject({ primary: { id: "boundary" }, secondary: { id: "twin" } });
    expect(relationOf("CXWU", "DXWU")).toMatchObject({ primary: { id: "well_and_road" }, secondary: { id: "twin" } });
  });
  test("every relation is reachable, and each type's best and hardest partner differ", () => {
    const seen = new Set(TYPE_CODES.flatMap((a) => TYPE_CODES.map((b) => relationOf(a, b).primary.id)));
    expect([...seen].sort()).toEqual(Object.keys(RELATIONS).sort());
    for (const code of TYPE_CODES) {
      const { best, hardest } = partnersOf(code);
      expect(best.code).not.toBe(code);
      expect(best.code).not.toBe(hardest.code);
      expect(pairFit(code, best.code)).toBeGreaterThan(pairFit(code, hardest.code));
    }
  });
  test("an unknown code is refused", () => {
    expect(() => relationOf("XXXX", "CLWU")).toThrow("TYPE_CODE_UNKNOWN");
  });
});

describe("rank and ambiguity", () => {
  test("within ten of the middle is ambiguous", () => {
    expect(isAmbiguous(55)).toBe(true);
    expect(isAmbiguous(40)).toBe(true);
    expect(isAmbiguous(61)).toBe(false);
  });
  test("the estimate rises with the lean, names the pole and says it is an estimate", () => {
    const mild = axisRank("concentration", 60), strong = axisRank("concentration", 90);
    expect(mild).toMatchObject({ pole: "多线并行", estimated: true });
    expect(strong.percent).toBeGreaterThan(mild.percent);
    expect(axisRank("concentration", 10).pole).toBe("单线主导");
    expect(axisRank("concentration", 100).percent).toBeLessThanOrEqual(96);
  });
  test("over 95 the rank is 91–96, fixed per result and axis, spread across results; at or under 95 it is untouched", () => {
    const seeds = Array.from({ length: 200 }, (_, index) => `result-${index}`);
    const shown = seeds.map((seed) => axisRank("concentration", 95, [], seed).percent);
    for (const value of shown) expect(value).toBeGreaterThanOrEqual(91), expect(value).toBeLessThanOrEqual(96);
    expect(new Set(shown).size).toBe(6);
    expect(axisRank("concentration", 95, [], "result-7").percent).toBe(axisRank("concentration", 95, [], "result-7").percent);
    expect(axisRank("concentration", 60, [], "x").percent).toBe(axisRank("concentration", 60).percent);
    expect(shownRank(95, "a", "concentration")).toBe(95);
    expect(shownRank(42, "a", "orientation")).toBe(42);
  });
  test("from two hundred recorded scores the rank is the people's own", () => {
    const recorded = Array.from({ length: 200 }, (_, index) => index % 2 ? 55 : 45);
    const rank = axisRank("concentration", 80, recorded, "r1");
    expect(rank.estimated).toBe(false);
    // 99% of recorded people lean less far, shown capped like the estimate.
    expect(rank.percent).toBe(shownRank(99, "r1", "concentration"));
    expect(rank.percent).toBeLessThanOrEqual(96);
  });
});
