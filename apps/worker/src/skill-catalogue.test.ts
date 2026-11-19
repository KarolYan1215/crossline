import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { SKILL_NEEDS } from "@crossline/core";
import { readSkillDescriptions, renderSkillCatalogue } from "../../../scripts/skill-catalogue-source";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("the skill catalogue 小帮手 routes by is generated from the current SKILL.md descriptions (pnpm exec tsx scripts/skill-catalogue.ts)", () => {
  const written = readFileSync(new URL("../../../packages/core/src/skill-catalogue.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  expect(written).toBe(renderSkillCatalogue(readSkillDescriptions(root)));
});

test("every Skill a note can go to has a description to route by", () => {
  const described = readSkillDescriptions(root);
  const missing = Object.entries(SKILL_NEEDS).filter(([id, needs]) => !needs.testOnly && !described[id]).map(([id]) => id);
  expect(missing).toEqual([]);
});
