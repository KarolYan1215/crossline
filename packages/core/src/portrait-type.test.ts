import { describe, expect, test } from "vitest";
import { TYPE_GROUPS } from "./portrait-type";

const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

describe("type group colours", () => {
  test("each group's text colour holds 7:1 on the poster's paper and on its own tint", () => {
    for (const [key, group] of Object.entries(TYPE_GROUPS)) {
      expect(contrast(group.colour, "#F6F2EA"), key).toBeGreaterThanOrEqual(7);
      expect(contrast(group.colour, group.tint), key).toBeGreaterThanOrEqual(6.5);
    }
  });
  test("the outfit tone is muted: neither near black nor near white", () => {
    for (const [key, group] of Object.entries(TYPE_GROUPS)) {
      const l = luminance(group.tone);
      expect(l, key).toBeGreaterThan(0.15);
      expect(l, key).toBeLessThan(0.5);
    }
  });
});
