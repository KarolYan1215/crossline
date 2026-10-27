import { expect, test } from "vitest";
import { appearanceBasis, FIGURE_FILE, figureRedrawDue, figureVersionOf, nextDrawnFigureFile, nextUploadedFigureFile } from "./portrait-figure";

const fact = (slot: string, value: string, updatedAt: string, over: { identityId?: string; status?: string } = {}) =>
  ({ identityId: "person", status: "confirmed", slot, value, updatedAt, ...over });

test("a figure is kept through report rewrites; only the person's own new description of how they look, or their request, draws again", () => {
  const facts = [fact("gender", "男。", "2026-10-14T07:16:40Z"), fact("hairstyle", "狼尾长发。", "2026-10-14T07:16:40Z"),
    fact("energy_peak", "上午", "2026-10-20T00:00:00Z"), fact("hairstyle", "短发", "2026-10-20T00:00:00Z", { status: "inferred" })];
  expect(appearanceBasis(facts)).toBe("gender=男。\nhairstyle=狼尾长发。");
  // No figure yet, or asked for: draw.
  expect(figureRedrawDue(undefined, facts)).toBe(true);
  expect(figureRedrawDue({ file: "v6-character.png", at: "2026-10-14T07:28:34Z", basis: appearanceBasis(facts) }, facts, true)).toBe(true);
  // Drawn from the same description: kept, whatever else changed (another fact, an inferred guess, a rewritten report).
  expect(figureRedrawDue({ file: "v6-character.png", at: "2026-10-14T07:28:34Z", basis: appearanceBasis(facts) }, facts)).toBe(false);
  // The person described themselves differently: draw.
  expect(figureRedrawDue({ file: "v6-character.png", at: "2026-10-14T07:28:34Z", basis: "gender=男。" }, facts)).toBe(true);
  // A drawing from before the basis was recorded: only an appearance fact changed after it draws again.
  expect(figureRedrawDue({ file: "v5-character.png", at: "2026-10-14T19:17:09Z" }, facts)).toBe(false);
  expect(figureRedrawDue({ file: "v5-character.png", at: "2026-10-14T19:17:09Z" }, [...facts, fact("appearance", "全黑穿搭", "2026-10-15T07:20:03Z")])).toBe(true);
  expect(figureRedrawDue({ file: "v5-character.png", at: "2026-10-14T19:17:09Z" }, [])).toBe(false);
});

test("figure files are named so that no drawing is ever written over, and nothing else is taken for one", () => {
  expect(nextDrawnFigureFile(6, [])).toBe("v6-character.png");
  expect(nextDrawnFigureFile(6, ["v6-character.png", "v6r2-character.png"])).toBe("v6r3-character.png");
  expect(nextUploadedFigureFile(["v6-character.png"])).toBe("u1-character.png");
  expect(nextUploadedFigureFile(["u1-character.png", "u3-character.png"])).toBe("u4-character.png");
  for (const ok of ["v5-character.png", "v6r2-character.png", "u1-character.png"]) expect(FIGURE_FILE.test(ok)).toBe(true);
  for (const bad of ["v2-cover.png", "u1r2-character.png", "../v1-character.png", "v1-character.png/x", "character.png"]) expect(FIGURE_FILE.test(bad)).toBe(false);
  expect(figureVersionOf("v6r2-character.png")).toEqual({ kind: "drawn", number: 6, redraw: 2 });
  expect(figureVersionOf("u2-character.png")).toEqual({ kind: "uploaded", number: 2, redraw: 1 });
  expect(figureVersionOf("v2-cover.png")).toBeNull();
});
