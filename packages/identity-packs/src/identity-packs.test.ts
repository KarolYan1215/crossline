import { describe, expect, test } from "vitest";
import { defaultIdentityPacks } from "./index";

describe("default identity packs", () => {
  test("research is the editable master clock and health is capacity policy", () => {
    const packs = defaultIdentityPacks();
    expect(packs.filter((pack) => pack.kind === "identity")).toHaveLength(4);
    expect(packs.find((pack) => pack.id === "research")?.masterClock).toBe(true);
    expect(packs.find((pack) => pack.id === "health")?.kind).toBe("capacity");
  });

  test("identity packs contain workflow and evidence policy but no personal goal", () => {
    for (const pack of defaultIdentityPacks()) {
      expect(pack.workflowTemplates.length).toBeGreaterThan(0);
      expect(pack.evidencePolicy).toBeTruthy();
      expect(pack).not.toHaveProperty("goal");
    }
  });

  test("identity packs provide inference contracts without personal details", () => {
    const research = defaultIdentityPacks().find((pack) => pack.id === "research");
    expect(research?.durationPriors).toEqual(expect.objectContaining({
      preparation: expect.objectContaining({ p25Minutes: expect.any(Number), p85Minutes: expect.any(Number) })
    }));
    expect(JSON.stringify(research)).not.toContain("Karol");
    expect(JSON.stringify(research)).not.toContain("FGFET");
  });
});
