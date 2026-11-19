/**
 * Writes packages/core/src/skill-catalogue.ts from each Skill's SKILL.md `description` (the frontmatter line), so 小帮手 can route a wish
 * about how a part of Crossline behaves to the Skill that owns it (`find_system_part`). Run after adding a Skill or changing a description:
 *   pnpm exec tsx scripts/skill-catalogue.ts
 * `apps/worker/src/skill-catalogue.test.ts` fails while the file is stale.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readSkillDescriptions, renderSkillCatalogue } from "./skill-catalogue-source";

const root = fileURLToPath(new URL("..", import.meta.url));
writeFileSync(new URL("../packages/core/src/skill-catalogue.ts", import.meta.url), renderSkillCatalogue(readSkillDescriptions(root)));
console.log("packages/core/src/skill-catalogue.ts written");
