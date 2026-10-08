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

test("an account from before keeps the built-in lines; a stored list replaces them, keeps the capacity pack, and hides archived lines", async () => {
  const { identityPacksFor, newLineId, freeLineColor, LINE_SETTING } = await import("./index");
  expect(identityPacksFor(() => undefined).filter((pack) => pack.kind === "identity").map((pack) => pack.id)).toEqual(["research", "startup", "media", "investment"]);
  const stored = JSON.stringify([
    { id: "research", label: "博士研究", color: "research", goal: "成为神经形态计算方向能独立立项的研究者", createdAt: "" },
    { id: "line-music", label: "音乐", color: "teal", goal: "", createdAt: "" },
    { id: "line-old", label: "旧线", color: "olive", goal: "", createdAt: "", archived: true }
  ]);
  const packs = identityPacksFor((key) => key === LINE_SETTING ? stored : undefined);
  expect(packs.map((pack) => [pack.id, pack.label, pack.kind])).toEqual([["research", "博士研究", "identity"], ["line-music", "音乐", "identity"], ["health", "健康容量", "capacity"]]);
  expect(packs[0]).toMatchObject({ masterClock: true, goal: "成为神经形态计算方向能独立立项的研究者" });
  // A new account with no lines yet has only the capacity pack.
  expect(identityPacksFor(() => "[]").map((pack) => pack.id)).toEqual(["health"]);
  expect(newLineId("Music 创作", ["line-music"])).toBe("line-music-2");
  expect(newLineId("摄影", [])).toBe("line-x");
  expect(freeLineColor([{ color: "research" }, { color: "startup" }, { color: "media" }, { color: "investment" }])).toBe("teal");
});
