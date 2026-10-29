import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { DISPLAY_SERIF, displaySerifText } from "./serif-strings";

/** A title added to `DISPLAY_SERIF` without rebuilding the subset would fall back to another face for its new characters. */
test("the display serif subset holds every Chinese character of the frame's serif titles", () => {
  const glyphs = new Set(readFileSync(path.resolve(import.meta.dirname, "../../public/fonts/display-serif.glyphs.txt"), "utf8"));
  expect([...displaySerifText()].filter((char) => !glyphs.has(char))).toEqual([]);
  expect(displaySerifText()).not.toMatch(/[A-Za-z0-9]/);
  expect(Object.values(DISPLAY_SERIF).every((title) => title.length > 0)).toBe(true);
});
