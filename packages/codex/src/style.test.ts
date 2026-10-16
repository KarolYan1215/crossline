import { afterEach, expect, test } from "vitest";
import { agentLanguageLine, runLocale, setLocaleProvider, STYLE_INSTRUCTIONS, styleInstructions } from "./style";

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
