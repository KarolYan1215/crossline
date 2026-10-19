import { expect, test } from "vitest";
import { dropEnumSlips, jsonSchemaProblems } from "./json-schema-check";
import { ONBOARDING_EXTRACT_SCHEMA } from "./onboarding-turn-schema";
import { conformanceProblems } from "./provider-conformance";

const schema = { type: "object", additionalProperties: false, required: ["energyMap", "mood"], properties: {
  mood: { type: "string", enum: ["calm", "busy"] },
  energyMap: { type: "array", items: { type: "object", additionalProperties: false, required: ["activity", "love"],
    properties: { activity: { type: "string", maxLength: 10 }, love: { type: "string", enum: ["high", "low"] } } } } } };

test("an enum slip costs its list item, a case slip is put right, and anything else is left for the validator", () => {
  const answer = { mood: " Calm", energyMap: [{ activity: "写论文", love: "high" }, { activity: "开组会", love: "medium" }, { activity: "这一项的活动名称太长了不止十个字", love: "low" }] };
  const kept = dropEnumSlips(answer, schema) as typeof answer;
  expect(kept.mood).toBe("calm");
  // The medium item had only an enum problem: gone. The long one has a length problem: kept for the validator to send back.
  expect(kept.energyMap.map((item) => item.activity)).toEqual(["写论文", "这一项的活动名称太长了不止十个字"]);
  expect(jsonSchemaProblems(kept, schema)).toEqual(["$.energyMap[1].activity: 16 characters, at most 10"]);
});

test("the extraction's conformance case forgives the slip GLM-5.3-Flash made on 2026-10-19; other schemas do not", () => {
  const energy = { energyMap: [{ activity: "跑步", skill: "high", love: "medium", charge: "charge" }], flow: [], says: "", does: "", anchor: "", realWant: "", refs: [] };
  const answer = { slotUpdates: [], projectsDetected: [], flywheelCandidates: [], fileDates: { items: [], undated: [] }, lineProfiles: [], goalEdits: [],
    availability: { windows: [], why: "" }, profileSections: { situation: null, compass: null, energy, synthesis: null } };
  const strict = jsonSchemaProblems(answer, ONBOARDING_EXTRACT_SCHEMA);
  expect(strict.some((problem) => problem.includes("love"))).toBe(true);
  expect(conformanceProblems("ONBOARDING_EXTRACT_SCHEMA", answer, ONBOARDING_EXTRACT_SCHEMA).some((problem) => problem.includes("love"))).toBe(false);
  expect(conformanceProblems("OTHER_SCHEMA", answer, ONBOARDING_EXTRACT_SCHEMA)).toEqual(strict);
});
