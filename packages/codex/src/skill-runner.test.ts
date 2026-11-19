import { afterEach, describe, expect, test } from "vitest";
import { SOURCE_ORDER_INSTRUCTION, setLocalLookupProvider, setWebAvailableProvider, withSourceDefaults } from "./skill-runner";

describe("source defaults (2026-11-18: web as needed, the person's files first)", () => {
  const base: Parameters<typeof withSourceDefaults>[0] = { skillName: "crossline:crossline-task-titler", developerInstructions: "do it" };
  const files = { specs: [{ name: "search_my_files", description: "", inputSchema: {} }], call: () => "x" };
  afterEach(() => { setWebAvailableProvider(() => false); setLocalLookupProvider(undefined); });

  test("a run that says nothing gets the web where Codex can search, and the source order", () => {
    setWebAvailableProvider(() => true);
    const out = withSourceDefaults(base, { functionCalls: true });
    expect(out.allowWebSearch).toBe(true);
    expect(out.developerInstructions).toContain(SOURCE_ORDER_INSTRUCTION);
  });

  test("an explicit false keeps a run off the web; without a search host nothing is added", () => {
    setWebAvailableProvider(() => true);
    expect(withSourceDefaults({ ...base, allowWebSearch: false }, { functionCalls: false }).allowWebSearch).toBe(false);
    setWebAvailableProvider(() => false);
    const out = withSourceDefaults(base, { functionCalls: false });
    expect(out.allowWebSearch).toBe(false);
    expect(out.developerInstructions).toBe("do it");
  });

  test("the person's files are offered where the route calls functions, not beside the planner's own material search", () => {
    setLocalLookupProvider(() => files);
    expect(withSourceDefaults(base, { functionCalls: true }).tools?.specs.map((spec: { name: string }) => spec.name)).toEqual(["search_my_files"]);
    expect(withSourceDefaults(base, { functionCalls: false }).tools).toBeUndefined();
    const planner = { ...base, tools: { specs: [{ name: "search_material", description: "", inputSchema: {} }], call: () => "" } };
    expect(withSourceDefaults(planner, { functionCalls: true }).tools?.specs.map((spec: { name: string }) => spec.name)).toEqual(["search_material"]);
  });
});
