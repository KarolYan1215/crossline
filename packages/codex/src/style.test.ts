import { afterEach, expect, test } from "vitest";
import { agentLanguageLine, runLocale, schemaForLocale, setLocaleProvider, STYLE_INSTRUCTIONS, styleInstructions } from "./style";

afterEach(() => setLocaleProvider(undefined));

test("a run writes in its workspace's language, and an explicit language (the interview's) wins", () => {
  expect(runLocale(undefined, "ws")).toBe("zh");
  setLocaleProvider((workspaceId) => workspaceId === "ws-en" ? "en" : undefined);
  expect(runLocale(undefined, "ws-en")).toBe("en");
  expect(runLocale(undefined, "ws-zh")).toBe("zh");
  expect(runLocale("zh", "ws-en")).toBe("zh");
  setLocaleProvider(() => { throw new Error("ledger closed"); });
  expect(runLocale(undefined, "ws-en")).toBe("zh");
});

test("the English block overrides the Skills' Chinese wording and keeps the fixed vocabulary", () => {
  expect(styleInstructions(undefined)).toBe(STYLE_INSTRUCTIONS);
  expect(styleInstructions("zh")).toContain("Output language: Simplified Chinese");
  const english = styleInstructions("en");
  expect(english).toContain("Output language: English");
  expect(english).toContain("overrides any instruction elsewhere to write in Chinese");
  expect(english).toContain("Track (主线)");
  expect(agentLanguageLine("en")).toContain("English");
});

test("an English answer gets room: string limits widen, everything else is the same schema", () => {
  const schema = { type: "object", properties: { title: { type: "string", maxLength: 24 }, items: { type: "array", maxItems: 3, items: { type: "string", maxLength: 80 } } } };
  expect(schemaForLocale(schema, "zh")).toBe(schema);
  expect(schemaForLocale(schema, "en")).toEqual({ type: "object", properties: { title: { type: "string", maxLength: 60 },
    items: { type: "array", maxItems: 3, items: { type: "string", maxLength: 200 } } } });
  expect(schema.properties.title.maxLength).toBe(24);
});

test("fields a Skill writes to the person are named in the style, so its 你 and the shared third-person rule never contradict", () => {
  const plain = styleInstructions("zh");
  expect(plain).toContain("Do not address the reader as 你/您");
  const interview = styleInstructions("zh", ["reply", "questions"]);
  expect(interview).toContain("`reply`, `questions` speak to the person as 你 (never 您)");
  expect(interview).not.toContain("Do not address the reader as 你/您");
  expect(styleInstructions("en", ["reply"])).toContain("`reply` speak to the person as \"you\"");
});
