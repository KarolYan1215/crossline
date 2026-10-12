import { readdirSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { REQUIRED_SKILLS } from "./required-skills";

test("every required Skill exists in the plugin, so the supervisor can report ready", () => {
  const dir = path.resolve(import.meta.dirname, "../../../skills/marketplace/plugins/crossline/skills");
  const present = new Set(readdirSync(dir).map((name) => `crossline:${name}`));
  expect(REQUIRED_SKILLS.filter((name) => !present.has(name))).toEqual([]);
});
