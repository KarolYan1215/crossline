import { describe, expect, test } from "vitest";
import { QUIZ_ITEMS, quizScores } from "./assess";
import { RELATIONS, TYPE_CODES, TYPE_LINES, TYPE_SUBTITLE, axisRank, isAmbiguous, pairFit, partnersOf, relationOf } from "./assess-content";
import { TYPE_AXES } from "./portrait-type";

describe("the thirty-two statements", () => {
  test("eight per axis, four keyed to each pole, ids unique, neighbours never on one axis", () => {
    expect(QUIZ_ITEMS).toHaveLength(32);
    expect(new Set(QUIZ_ITEMS.map((item) => item.id)).size).toBe(32);
    for (const axis of TYPE_AXES) {
      const own = QUIZ_ITEMS.filter((item) => item.axis === axis.id);
      expect(own).toHaveLength(8);
      expect(own.filter((item) => item.reverse)).toHaveLength(4);
    }
    QUIZ_ITEMS.slice(1).forEach((item, index) => expect(item.axis).not.toBe(QUIZ_ITEMS[index]!.axis));
  });
  test("all agree on the right pole and disagree on the left reads 100; the opposite 0", () => {
    const right = Object.fromEntries(QUIZ_ITEMS.map((item) => [item.id, item.reverse ? 1 : 5]));
    expect(Object.values(quizScores(right))).toEqual([100, 100, 100, 100]);
    const left = Object.fromEntries(QUIZ_ITEMS.map((item) => [item.id, item.reverse ? 5 : 1]));
    expect(Object.values(quizScores(left))).toEqual([0, 0, 0, 0]);
  });
});

describe("type content", () => {
  test("every type has a subtitle, three lines and a four-step loop", () => {
    expect(TYPE_CODES).toHaveLength(16);
    for (const code of TYPE_CODES) {
      expect(TYPE_SUBTITLE[code]!.length).toBeGreaterThan(4);
      expect(TYPE_LINES[code]!.lines).toHaveLength(3);
      expect(TYPE_LINES[code]!.loop).toHaveLength(4);
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
    expect(relationOf("SEMP", "SEMP").primary.id).toBe("twin");
    expect(relationOf("SEMP", "SEMA")).toMatchObject({ primary: { id: "pace" }, secondary: { id: "twin" } });
    expect(relationOf("SEMP", "SIMP")).toMatchObject({ primary: { id: "data_vs_hunch" }, secondary: { id: "twin" } });
    expect(relationOf("SEMP", "GIRA").primary.id).toBe("mirror");
    expect(relationOf("GIMA", "SIRA").primary.id).toBe("rabbit_holes");
    expect(relationOf("SEMP", "GERP").primary.id).toBe("double_safe");
    expect(relationOf("SEMP", "SERA").primary.id).toBe("pace");
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
    expect(() => relationOf("XXXX", "SEMP")).toThrow("TYPE_CODE_UNKNOWN");
  });
});

describe("rank and ambiguity", () => {
  test("within ten of the middle is ambiguous", () => {
    expect(isAmbiguous(55)).toBe(true);
    expect(isAmbiguous(40)).toBe(true);
    expect(isAmbiguous(61)).toBe(false);
  });
  test("the estimate rises with the lean, names the pole and says it is an estimate", () => {
    const mild = axisRank("scope", 60), strong = axisRank("scope", 90);
    expect(mild).toMatchObject({ pole: "跨界", estimated: true });
    expect(strong.percent).toBeGreaterThan(mild.percent);
    expect(axisRank("scope", 10).pole).toBe("深耕");
    expect(axisRank("scope", 100).percent).toBeLessThanOrEqual(99);
  });
  test("from two hundred recorded scores the rank is the people's own", () => {
    const recorded = Array.from({ length: 200 }, (_, index) => index % 2 ? 55 : 45);
    const rank = axisRank("scope", 80, recorded);
    expect(rank).toMatchObject({ estimated: false, percent: 99 });
  });
});
