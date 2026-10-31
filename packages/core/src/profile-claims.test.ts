import { describe, expect, test } from "vitest";
import { PROFILE_ITEMS, type InstrumentAnswers, type ItemAnswer } from "./profile-instruments";
import {
  claimIdOf, exportableClaims, instrumentClaims, instrumentReadings, readClaimStatus, reportSections, resolveWrittenClaims
} from "./profile-claims";
import { WRITTEN_CLAIMS_SCHEMA, claimProblem, readPrivacyChoices, type WrittenClaim } from "./profile-report";
import { PORTRAIT_SCHEMA } from "./portrait";

const at = "2026-10-31T10:00:00.000Z";
const tap = (itemId: string, score: number): ItemAnswer => ({ itemId, score, by: "tapped", at });
const map = (itemId: string, score: number): ItemAnswer => ({ itemId, score, by: "mapped", confidence: 0.7, refs: [3], at });
const dimensionOf = (id: string) => PROFILE_ITEMS.find((item) => item.id === id)!.dimension;
const answersFor = (instrument: string, scoreOf: (id: string) => number, by = tap) =>
  Object.fromEntries(PROFILE_ITEMS.filter((item) => item.instrument === instrument).map((item) => [item.id, by(item.id, scoreOf(item.id))])) as InstrumentAnswers;

describe("the cards' claims", () => {
  test("every Big Five domain with a score becomes a measured claim when tapped, an inferred one when read from words", () => {
    const tapped = instrumentClaims(answersFor("mini_ipip", () => 3), at);
    expect(tapped.filter((claim) => claim.section === "personality")).toHaveLength(5);
    expect(tapped.every((claim) => claim.kind === "measured" && claim.confidence === 0.8 && claimProblem(claim) === null)).toBe(true);
    expect(tapped[0]!.statement).toMatch(/中等（50\/100，4 题点选）/);
    // Two of four by words: still scored, but inferred and less sure.
    const mixed: InstrumentAnswers = answersFor("mini_ipip", () => 4);
    const extraversion = PROFILE_ITEMS.filter((item) => item.instrument === "mini_ipip" && item.dimension === "E").map((item) => item.id);
    for (const id of extraversion.slice(0, 2)) mixed[id] = map(id, 4);
    const e = instrumentClaims(mixed, at).find((claim) => claim.statement.startsWith("外向"))!;
    expect(e).toMatchObject({ kind: "inferred", confidence: 0.6 });
    expect(e.basis[0]).toMatchObject({ instrument: "mini_ipip", administration: "mixed", items: extraversion });
  });

  test("a domain with an unanswered item says nothing, and no claim carries a number the cards did not give", () => {
    const answers = answersFor("mini_ipip", () => 5);
    delete answers[PROFILE_ITEMS.find((item) => item.instrument === "mini_ipip")!.id];
    expect(instrumentClaims(answers, at)).toHaveLength(4);
    expect(instrumentClaims({}, at)).toEqual([]);
  });

  test("interests name the three strongest and the weakest; values the top three and the two given up most easily", () => {
    const interests = instrumentClaims(answersFor("rest18", (id) => ({ A: 5, S: 4, I: 3, R: 2, E: 2 } as Record<string, number>)[dimensionOf(id)] ?? 1), at);
    expect(interests).toHaveLength(1);
    expect(interests[0]!.statement).toMatch(/^最想做的工作类型：艺术型（100）、社会型（75）、研究型（50）；最不想做：/);
    const values = instrumentClaims(answersFor("values", () => 1), at);
    expect(values[0]!.section).toBe("values");
    expect(values[0]!.statement).toMatch(/^取舍时更看重：.+；更容易让出：.+/);
  });

  test("the writer is told levels in words, never the numbers", () => {
    const lines = instrumentReadings(answersFor("swls", () => 5));
    expect(lines).toEqual(["生活满意度：偏高（5 题点选）"]);
    expect(lines.join("")).not.toMatch(/\d+\/100/);
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
  const claims = [...instrumentClaims(answersFor("swls", () => 2), at),
    ...resolveWrittenClaims([{ section: "tensions", statement: "自由和稳定互相拉扯", kind: "inferred", confidence: 0.5, quote: "又想自由又怕没钱" },
      { section: "collaboration", statement: "给结论前先给两个选项", kind: "self_reported", confidence: 0.8, quote: "先给我两个选项" }],
    ["又想自由又怕没钱。", "你先给我两个选项就行。"], { at })];

  test("tensions are private by default: the person sees them, an agent and the export do not", () => {
    const own = reportSections(claims, readPrivacyChoices(null), "private");
    expect(own.map((section) => section.section)[0]).toBe("collaboration");
    expect(own.find((section) => section.section === "tensions")!.claims).toHaveLength(1);
    expect(reportSections(claims, readPrivacyChoices(null), "agent").find((section) => section.section === "tensions")!.claims).toEqual([]);
    expect(exportableClaims(claims, readPrivacyChoices(null), {}).map((claim) => claim.section).sort()).toEqual(["collaboration", "lifestyle"]);
  });

  test("a section made private leaves the export; a rejected claim leaves the export but stays on the person's own page", () => {
    const choices = readPrivacyChoices(JSON.stringify({ sections: { lifestyle: "private" } }));
    expect(exportableClaims(claims, choices, {}).map((claim) => claim.section)).toEqual(["collaboration"]);
    const collab = claims.find((claim) => claim.section === "collaboration")!;
    const status = readClaimStatus(JSON.stringify({ [collab.id]: { status: "rejected", at, statement: collab.statement }, bad: { status: "maybe" } }));
    expect(Object.keys(status)).toEqual([collab.id]);
    expect(exportableClaims(claims, readPrivacyChoices(null), status).map((claim) => claim.section)).toEqual(["lifestyle"]);
    expect(reportSections(claims, readPrivacyChoices(null), "private", status).find((section) => section.section === "collaboration")!.claims[0])
      .toMatchObject({ personStatus: "rejected" });
  });
});
