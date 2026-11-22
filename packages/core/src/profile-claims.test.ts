import { describe, expect, test } from "vitest";
import { PROFILE_ITEMS, type InstrumentAnswers, type ItemAnswer } from "./profile-instruments";
import {
  claimIdOf, exportableClaims, instrumentClaims, instrumentLevels, instrumentReadings, readClaimStatus, reportSections, resolveWrittenClaims
} from "./profile-claims";
import { WRITTEN_CLAIMS_SCHEMA, claimProblem, readPrivacyChoices, type WrittenClaim } from "./profile-report";
import { PORTRAIT_SCHEMA } from "./portrait";

const at = "2026-10-31T10:00:00.000Z";
const tap = (itemId: string, score: number): ItemAnswer => ({ itemId, score, by: "tapped", at });
const map = (itemId: string, score: number): ItemAnswer => ({ itemId, score, by: "mapped", confidence: 0.7, refs: [3], at });
const answersFor = (instrument: string, scoreOf: (id: string) => number, by = tap) =>
  Object.fromEntries(PROFILE_ITEMS.filter((item) => item.instrument === instrument).map((item) => [item.id, by(item.id, scoreOf(item.id))])) as InstrumentAnswers;


describe("the scale's claims", () => {
  test("every Big Five domain with a score becomes a measured claim with its percentile when tapped, an inferred one when read from words", () => {
    const tapped = instrumentClaims(answersFor("ipip_neo_120", () => 3), at);
    expect(tapped.filter((claim) => claim.section === "personality")).toHaveLength(5);
    expect(tapped.every((claim) => claim.kind === "measured" && claim.confidence === 0.8 && claimProblem(claim) === null)).toBe(true);
    expect(tapped[0]!.statement).toMatch(/（第 \d+ 百分位，24 题点选）$/);
    // Two of the 24 by words: still scored, but inferred and less sure.
    const mixed: InstrumentAnswers = answersFor("ipip_neo_120", () => 4);
    const extraversion = PROFILE_ITEMS.filter((item) => item.instrument === "ipip_neo_120" && item.dimension === "E").map((item) => item.id);
    for (const id of extraversion.slice(0, 2)) mixed[id] = map(id, 4);
    const e = instrumentClaims(mixed, at).find((claim) => claim.statement.startsWith("外向"))!;
    expect(e).toMatchObject({ kind: "inferred", confidence: 0.6 });
    expect(e.basis[0]).toMatchObject({ instrument: "ipip_neo_120", administration: "mixed", items: extraversion });
  });

  test("a domain with a facet half answered says nothing, and no claim comes from no answers", () => {
    const answers = answersFor("ipip_neo_120", () => 5);
    const n1 = PROFILE_ITEMS.filter((item) => item.facet === "N1");
    delete answers[n1[0]!.id];
    delete answers[n1[1]!.id];
    expect(instrumentClaims(answers, at)).toHaveLength(4);
    expect(instrumentClaims({}, at)).toEqual([]);
  });

  test("values name the top three and the two that matter least, in the person's own order", () => {
    const high = new Set(["twivi-6", "twivi-16", "twivi-5", "twivi-15", "twivi-3", "twivi-13"]);
    const values = instrumentClaims(answersFor("twivi", (id) => (high.has(id) ? 6 : id === "twivi-9" || id === "twivi-19" ? 1 : 3)), at);
    expect(values).toHaveLength(1);
    expect(values[0]!.section).toBe("values");
    expect(values[0]!.statement).toMatch(/^最看重：.*刺激.*；相对最不看重：.*权力/);
    expect(values[0]!.statement).toMatch(/自主/);
  });

  test("the writer is told levels with percentiles and the values' order, and the person's page gets each scored dimension's level in words", () => {
    const answers = { ...answersFor("ipip_neo_120", () => 3), ...answersFor("twivi", (id) => (id === "twivi-6" || id === "twivi-16" ? 6 : 3)) };
    const lines = instrumentReadings(answers);
    expect(lines).toHaveLength(6);
    expect(lines[5]).toMatch(/^价值观（本人自己的排序，高到低）：刺激、/);
    const levels = instrumentLevels(answers);
    expect(levels).toHaveLength(8);
    expect(levels[5]).toEqual({ label: "刺激", level: "第 1 看重" });
    expect(instrumentLevels({})).toEqual([]);
  });
});


describe("the writer's claims", () => {
  const replies = ["我每次截稿前一晚都会通宵，第二天整天什么都干不了。", "做插画让我觉得自己还活着。"];
  const written = (over: Partial<WrittenClaim>): WrittenClaim =>
    ({ section: "work_style", statement: "截稿前一晚常通宵，第二天整天不工作", kind: "self_reported", confidence: 0.8, quote: "截稿前一晚都会通宵", ...over });

  test("a claim is kept only with a quote really in the replies, punctuation aside, and points at its sentence", () => {
    const kept = resolveWrittenClaims([written({}), written({ statement: "画画充电", section: "motivation", quote: "做插画，让我觉得自己还活着" }),
      written({ statement: "编的", quote: "我最爱做表格" })], replies, { at, sentenceOf: (quote) => (quote.includes("通宵") ? 41 : undefined) });
    expect(kept.map((claim) => claim.statement)).toEqual(["截稿前一晚常通宵，第二天整天不工作", "画画充电"]);
    expect(kept[0]).toMatchObject({ kind: "self_reported", basis: [{ sentenceId: 41, quote: "截稿前一晚都会通宵" }], reviewBy: "2027-01-29" });
    expect(kept.every((claim) => claimProblem(claim) === null)).toBe(true);
  });

  test("a claim the person rejected is not written again, and a repeated one is kept once", () => {
    const id = claimIdOf("work_style", "截稿前一晚常通宵，第二天整天不工作");
    expect(resolveWrittenClaims([written({})], replies, { at, rejected: new Set([id]) })).toEqual([]);
    expect(resolveWrittenClaims([written({}), written({ statement: "截稿前一晚常通宵， 第二天整天不工作" })], replies, { at })).toHaveLength(1);
    expect(resolveWrittenClaims([written({ section: "overview" as WrittenClaim["section"] })], replies, { at })).toEqual([]);
  });

  test("the portrait schema carries the claims under strict mode", () => {
    expect((PORTRAIT_SCHEMA.properties as Record<string, unknown>).claims).toBe(WRITTEN_CLAIMS_SCHEMA);
    expect(PORTRAIT_SCHEMA.required).toContain("claims");
    expect(WRITTEN_CLAIMS_SCHEMA.items.properties.section.enum).not.toContain("overview");
  });
});

describe("sections, privacy and export", () => {
  const claims = [...instrumentClaims(answersFor("twivi", () => 2), at),
    ...resolveWrittenClaims([{ section: "tensions", statement: "自由和稳定互相拉扯", kind: "inferred", confidence: 0.5, quote: "又想自由又怕没钱" },
      { section: "collaboration", statement: "给结论前先给两个选项", kind: "self_reported", confidence: 0.8, quote: "先给我两个选项" }],
    ["又想自由又怕没钱。", "你先给我两个选项就行。"], { at })];

  test("tensions are private by default: the person sees them, an agent and the export do not", () => {
    const own = reportSections(claims, readPrivacyChoices(null), "private");
    expect(own.map((section) => section.section)[0]).toBe("collaboration");
    expect(own.find((section) => section.section === "tensions")!.claims).toHaveLength(1);
    expect(reportSections(claims, readPrivacyChoices(null), "agent").find((section) => section.section === "tensions")!.claims).toEqual([]);
    expect(exportableClaims(claims, readPrivacyChoices(null), {}).map((claim) => claim.section).sort()).toEqual(["collaboration", "values"]);
  });

  test("a section made private leaves the export; a rejected claim leaves the export but stays on the person's own page", () => {
    const choices = readPrivacyChoices(JSON.stringify({ sections: { values: "private" } }));
    expect(exportableClaims(claims, choices, {}).map((claim) => claim.section)).toEqual(["collaboration"]);
    const collab = claims.find((claim) => claim.section === "collaboration")!;
    const status = readClaimStatus(JSON.stringify({ [collab.id]: { status: "rejected", at, statement: collab.statement }, bad: { status: "maybe" } }));
    expect(Object.keys(status)).toEqual([collab.id]);
    expect(exportableClaims(claims, readPrivacyChoices(null), status).map((claim) => claim.section)).toEqual(["values"]);
    expect(reportSections(claims, readPrivacyChoices(null), "private", status).find((section) => section.section === "collaboration")!.claims[0])
      .toMatchObject({ personStatus: "rejected" });
  });
});
