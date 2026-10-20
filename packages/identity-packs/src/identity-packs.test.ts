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
    { id: "research", label: "研究者", color: "research", goal: "成为神经形态计算方向能独立立项的研究者", createdAt: "", hard: true },
    { id: "line-music", label: "音乐", color: "teal", goal: "", createdAt: "" },
    { id: "line-old", label: "旧线", color: "olive", goal: "", createdAt: "", archived: true }
  ]);
  const packs = identityPacksFor((key) => key === LINE_SETTING ? stored : undefined);
  expect(packs.map((pack) => [pack.id, pack.label, pack.kind])).toEqual([["research", "研究者", "identity"], ["line-music", "音乐", "identity"], ["health", "健康容量", "capacity"]]);
  // The hard-constraint line carries the deadline clock; a line nobody ranked or constrained runs in parallel.
  expect(packs[0]).toMatchObject({ masterClock: true, hard: true, goals: ["成为神经形态计算方向能独立立项的研究者"] });
  expect(packs[1]).toMatchObject({ masterClock: false });
  // A new account with no lines yet has only the capacity pack.
  expect(identityPacksFor(() => "[]").map((pack) => pack.id)).toEqual(["health"]);
  expect(newLineId("Music 创作", ["line-music"])).toBe("line-music-2");
  expect(newLineId("摄影", [])).toBe("line-x");
  expect(freeLineColor([{ color: "research" }, { color: "startup" }, { color: "media" }, { color: "investment" }])).toBe("teal");
});

test("a domain line brings its pack's templates, topic and red line; a built-in line tagged with a domain keeps its own and gains the red line", async () => {
  const { identityPacksFor, LINE_SETTING, DOMAIN_PACKS, domainLineId, lineForDomain } = await import("./index");
  const stored = JSON.stringify([
    { id: "line-wellness", label: "健康管理者", color: "olive", goal: "", createdAt: "", domain: "wellness" },
    { id: "line-wealth", label: "理财者", color: "teal", goal: "", createdAt: "", domain: "wealth" },
    { id: "investment", label: "投资者", color: "investment", goal: "", createdAt: "", archived: true, domain: "wealth" }
  ]);
  const packs = identityPacksFor((key) => key === LINE_SETTING ? stored : undefined, { includeArchived: true });
  expect(packs.find((pack) => pack.id === "line-wellness")).toMatchObject({ kind: "identity", domain: "wellness", diligenceTopic: "evidence_summary",
    workflowTemplates: DOMAIN_PACKS.wellness.workflowTemplates });
  expect(packs.find((pack) => pack.id === "line-wellness")).not.toHaveProperty("noTradeCalls");
  expect(packs.find((pack) => pack.id === "line-wealth")).toMatchObject({ domain: "wealth", diligenceTopic: "tracking_framework", noTradeCalls: true });
  expect(packs.find((pack) => pack.id === "investment")).toMatchObject({ domain: "wealth", noTradeCalls: true, workflowTemplates: ["pre-market-brief", "midday-check", "close-review"] });
  // The health capacity pack is still there and is not the wellness line.
  expect(packs.filter((pack) => pack.kind === "capacity").map((pack) => pack.id)).toEqual(["health"]);
  // One live line per domain; an archived one does not hold the domain. The fixed id is used while free.
  const specs = JSON.parse(stored) as Array<{ id: string; domain?: "wellness" | "wealth"; archived?: boolean }>;
  expect(lineForDomain(specs, "wealth")?.id).toBe("line-wealth");
  expect(lineForDomain(specs.filter((line) => line.id !== "line-wealth"), "wealth")).toBeUndefined();
  expect(domainLineId("wellness", "健康管理者", [])).toBe("line-wellness");
  expect(domainLineId("wellness", "Wellness", ["line-wellness"])).toBe("line-wellness-2");
});

test("only domain lines get an interview checklist, with their fixed slots", async () => {
  const { domainGuides } = await import("./index");
  const guides = domainGuides([{ id: "line-x", label: "上班" }, { id: "line-wealth", label: "理财者", domain: "wealth" }]);
  expect(guides.map((guide) => [guide.lineId, guide.domain])).toEqual([["line-wealth", "财富"]]);
  expect(guides[0]!.slots).toContain("wealth_emergency_months：应急金可覆盖的月数");
  expect(guides[0]!.ask.join("")).toContain("不给买卖建议");
});

// The owner's decision of 2026-10-20: the lite edition's fixed-schedule line is named for a person, from what was typed.
test("the fixed-schedule line takes a noun for a person", async () => {
  const { lineNounFor } = await import("./index");
  expect(lineNounFor("上班")).toEqual({ noun: "职场人", certain: true });
  expect(lineNounFor(" 每天上班 ")).toEqual({ noun: "职场人", certain: true });
  expect(lineNounFor("上学")).toEqual({ noun: "学生", certain: true });
  expect(lineNounFor("自由职业")).toEqual({ noun: "自由职业者", certain: true });
  expect(lineNounFor("带娃")).toEqual({ noun: "家长", certain: true });
  expect(lineNounFor("实习")).toEqual({ noun: "实习生", certain: true });
  // Already a person: kept as typed.
  expect(lineNounFor("护士")).toEqual({ noun: "护士", certain: true });
  expect(lineNounFor("上班族")).toEqual({ noun: "上班族", certain: true });
  expect(lineNounFor("研究生")).toEqual({ noun: "研究生", certain: true });
  // Unknown: kept, and the card asks the person to name it.
  expect(lineNounFor("健身房值班表")).toEqual({ noun: "健身房值班表", certain: false });
  expect(lineNounFor("  ")).toEqual({ noun: "", certain: false });
});
