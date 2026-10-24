import { describe, expect, test } from "vitest";
import { QUIZ_ITEMS } from "./assess";
import { AI_KEEPS, LINE_IDENTITIES, RELATIONS, TYPE_CODES, TYPE_KINDRED, TYPE_LINES, TYPE_SUBTITLE, axisRank, isAmbiguous, shownRank, pairFit, partnersOf, relationOf } from "./assess-content";
import { TYPE_AXES } from "./portrait-type";

describe("the thirty-six questions", () => {
  test("nine per dimension, ids unique, neighbours never on one dimension", () => {
    expect(QUIZ_ITEMS).toHaveLength(36);
    for (const axis of TYPE_AXES) expect(QUIZ_ITEMS.filter((item) => item.axis === axis.id)).toHaveLength(9);
    QUIZ_ITEMS.slice(1).forEach((item, index) => expect(item.axis).not.toBe(QUIZ_ITEMS[index]!.axis));
  });
  test("both options are short enough for a phone, and differ", () => {
    for (const item of QUIZ_ITEMS) {
      expect(item.a, item.id).not.toBe(item.b);
      expect([...item.a].length, item.id).toBeLessThanOrEqual(26);
      expect([...item.b].length, item.id).toBeLessThanOrEqual(26);
    }
  });
});

describe("type content", () => {
  test("every type has a quote, a 「你不让 AI 碰的」 line, a kindred person with a sourced line, three lines and a four-step loop", () => {
    expect(TYPE_CODES).toHaveLength(16);
    for (const code of TYPE_CODES) {
      expect(TYPE_SUBTITLE[code]!.length).toBeGreaterThan(4);
      expect(AI_KEEPS[code]!.length, code).toBeGreaterThan(1);
      const kindred = TYPE_KINDRED[code]!;
      expect(kindred.name && kindred.why && kindred.quote.original && kindred.quote.source, code).toBeTruthy();
      // A Chinese original needs no translation; any other language carries ours.
      if (!/[\u4e00-\u9fff]/.test(kindred.quote.original)) expect(kindred.quote.translation, code).toBeTruthy();
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
    expect(relationOf("ROBA", "ROBA").primary.id).toBe("twin");
    expect(relationOf("ROBA", "WUHG").primary.id).toBe("mirror");
    expect(relationOf("ROBA", "WOBA")).toMatchObject({ primary: { id: "cake_dough" }, secondary: { id: "twin" } });
    expect(relationOf("ROBA", "RUBA")).toMatchObject({ primary: { id: "result_growth" }, secondary: { id: "twin" } });
    expect(relationOf("ROBA", "ROHA")).toMatchObject({ primary: { id: "blueprint_hands" }, secondary: { id: "twin" } });
    expect(relationOf("ROBA", "ROBG")).toMatchObject({ primary: { id: "well_stars" }, secondary: { id: "twin" } });
    expect(relationOf("ROBA", "WOHA")).toMatchObject({ primary: { id: "cake_dough" }, secondary: { id: "blueprint_hands" } });
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
    expect(() => relationOf("XXXX", "ROBA")).toThrow("TYPE_CODE_UNKNOWN");
  });
});

describe("rank and ambiguity", () => {
  test("within ten of the middle is ambiguous", () => {
    expect(isAmbiguous(55)).toBe(true);
    expect(isAmbiguous(40)).toBe(true);
    expect(isAmbiguous(61)).toBe(false);
  });
  test("the estimate rises with the lean, names the pole and says it is an estimate", () => {
    const mild = axisRank("lines", 60), strong = axisRank("lines", 90);
    expect(mild).toMatchObject({ pole: "多星", estimated: true });
    expect(strong.percent).toBeGreaterThan(mild.percent);
    expect(axisRank("lines", 10).pole).toBe("单核");
    expect(axisRank("lines", 100).percent).toBeLessThanOrEqual(96);
  });
  test("over 95 the rank is 91–96, fixed per result and axis, spread across results; at or under 95 it is untouched", () => {
    const seeds = Array.from({ length: 200 }, (_, index) => `result-${index}`);
    const shown = seeds.map((seed) => axisRank("lines", 95, [], seed).percent);
    for (const value of shown) expect(value).toBeGreaterThanOrEqual(91), expect(value).toBeLessThanOrEqual(96);
    expect(new Set(shown).size).toBe(6);
    expect(axisRank("lines", 95, [], "result-7").percent).toBe(axisRank("lines", 95, [], "result-7").percent);
    expect(axisRank("lines", 60, [], "x").percent).toBe(axisRank("lines", 60).percent);
    expect(shownRank(95, "a", "lines")).toBe(95);
    expect(shownRank(42, "a", "purpose")).toBe(42);
  });
  test("from two hundred recorded scores the rank is the people's own", () => {
    const recorded = Array.from({ length: 200 }, (_, index) => index % 2 ? 55 : 45);
    const rank = axisRank("lines", 80, recorded, "r1");
    expect(rank.estimated).toBe(false);
    // 99% of recorded people lean less far, shown capped like the estimate.
    expect(rank.percent).toBe(shownRank(99, "r1", "lines"));
    expect(rank.percent).toBeLessThanOrEqual(96);
  });
});
