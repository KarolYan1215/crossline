import { expect, test } from "vitest";
import { applyPointChanges, cardCandidateIds, cardCandidates, numberNewHypotheses, hypothesisFromCard, hypothesisLogLines, pointSectionFor, rateHypothesis, unrateHypothesis, type PointChange, type ProfilePoint } from "./profile-points";
import type { Hypothesis } from "./profile-hypotheses";

const at = "2026-11-12T00:00:00.000Z";
const change = (over: Partial<PointChange>): PointChange => ({ op: "add", id: "", section: "situation", text: "论文和产品抢同一段时间",
  quotes: [{ ref: "reply-1", text: "论文 12 月中投稿，和产品在抢同一段时间。" }], external: [], why: "", ...over });

test("a point is added only with words and a quote, under an id the code gives; the same words are not added twice", () => {
  const { points, dropped } = applyPointChanges([], [change({ id: "x9" }), change({ text: "没有引用的要点", quotes: [] }), change({ text: " 论文和产品抢同一段时间。" }),
    change({ text: "求职看重稳定", section: "compass", external: [{ text: "调查", url: "https://example.org/s" }, { text: "坏", url: "ftp://x" }] })], at);
  expect(points.map((point) => [point.id, point.section, point.source, point.text])).toEqual([
    ["p1", "situation", "stated", "论文和产品抢同一段时间"], ["p2", "compass", "stated", "求职看重稳定"]]);
  expect(points[1]!.external).toEqual([{ text: "调查", url: "https://example.org/s" }]);
  expect(dropped).toBe(2);
});

test("a stated point is revised with new evidence and a reason, the old words kept in its log; a confirmed one is not the run's to change", () => {
  const confirmed: ProfilePoint = { id: "p2", section: "energy", text: "被看见时更投入", quotes: [], external: [], source: "confirmed", log: [] };
  const start = applyPointChanges([], [change({})], at).points.concat(confirmed);
  const revised = applyPointChanges(start, [
    change({ op: "revise", id: "p1", text: "论文优先，产品放到周末", why: "她说先保论文", quotes: [{ ref: "reply-3", text: "先保论文" }] }),
    change({ op: "revise", id: "p1", text: "没有理由的修订", quotes: [{ ref: "reply-3", text: "先保论文" }] }),
    change({ op: "revise", id: "p2", text: "改写本人确认的", why: "x" }),
    change({ op: "retract", id: "p2", why: "x" })], at);
  expect(revised.dropped).toBe(3);
  const p1 = revised.points.find((point) => point.id === "p1")!;
  expect(p1.text).toBe("论文优先，产品放到周末");
  expect(p1.quotes.map((quote) => quote.ref)).toEqual(["reply-1", "reply-3"]);
  expect(p1.log.at(-1)).toEqual({ at, op: "revise", before: "论文和产品抢同一段时间", why: "她说先保论文" });
  const retracted = applyPointChanges(revised.points, [change({ op: "retract", id: "p1", why: "她改口了" })], at).points;
  expect(retracted.find((point) => point.id === "p1")!.retracted).toBe(true);
});

const hypothesis = (over: Partial<Hypothesis> = {}): Hypothesis => ({ id: "h1", dimension: "D2", statement: "被看见时更投入",
  basis: [{ kind: "quote", text: "有人看的时候我做得更快", ref: "reply-2" }], falsifier: "没人看时同样投入", alternative: "", status: "open", ...over });
const card = { text: "你在被看见时投入更多", refs: [{ replyId: "reply-2", quote: "有人看的时候" }, { replyId: "reply-4", quote: "交给导师前一晚" }],
  external: [{ text: "研究", url: "https://example.org/r" }] };

test("准 confirms the hypothesis and puts the card in the ledger; 不准 refutes it with no point; 部分对 keeps it open and records the correction", () => {
  const profile = { hypotheses: [hypothesis()], points: [] as ProfilePoint[] };
  const fits = rateHypothesis(profile, { hypothesisId: "h1", cardKey: "s#4", verdict: "fits", card, section: "energy", at });
  expect(fits.hypotheses[0]).toMatchObject({ status: "supported", rated: "fits", cardKey: "s#4", pointId: "p1" });
  expect(fits.points[0]).toMatchObject({ id: "p1", source: "confirmed", hypothesisId: "h1", text: card.text,
    quotes: [{ ref: "reply-2", text: "有人看的时候" }, { ref: "reply-4", text: "交给导师前一晚" }], external: card.external });
  // Taken back: the point goes, the hypothesis is as it was.
  const undone = unrateHypothesis(fits, { hypothesisId: "h1", pointId: fits.pointId!, prior: fits.prior! });
  expect(undone.points).toEqual([]);
  expect(undone.hypotheses[0]).toEqual(hypothesis());
  const off = rateHypothesis(profile, { hypothesisId: "h1", cardKey: "s#4", verdict: "off", card, section: "energy", at });
  expect(off.points).toEqual([]);
  expect(off.hypotheses[0]).toMatchObject({ status: "refuted", rated: "off" });
  const partial = rateHypothesis(profile, { hypothesisId: "h1", cardKey: "s#4", verdict: "partial", correction: "只在导师看的时候", card, section: "energy", at });
  expect(partial.hypotheses[0]).toMatchObject({ status: "open", rated: "partial", pointId: "p1" });
  expect(partial.points[0]).toMatchObject({ source: "corrected", text: "只在导师看的时候", quotes: [{ ref: "card:s#4", text: "只在导师看的时候" }] });
});

test("a card naming no hypothesis on record becomes one; the dialogue is told the open ones and how the person rated the rest", () => {
  const made = hypothesisFromCard({ ...card, falsifier: "没人看时同样投入" }, "c4", "D2");
  expect(made).toMatchObject({ id: "c4", dimension: "D2", statement: card.text, status: "open",
    basis: [{ kind: "quote", ref: "reply-2" }, { kind: "quote", ref: "reply-4" }, { kind: "external", ref: "https://example.org/r" }] });
  const lines = hypothesisLogLines([hypothesis({ id: "h2", cardKey: "s#2", rated: "off", status: "refuted" }), made]);
  expect(lines).toEqual(["h2 被看见时更投入（本人说不准，不再提）", "c4 [D2] 你在被看见时投入更多（待问）"]);
  expect(pointSectionFor("lines", "D4")).toBe("compass");
  expect(pointSectionFor("energy", "D4")).toBe("energy");
});

test("the next card is chosen from the log: hypotheses never carded that rest on two replies, the least-asked dimension first", () => {
  const two = [{ kind: "quote" as const, text: "有人看的时候我做得更快", ref: "reply-2" }, { kind: "behavior" as const, text: "交给导师前一晚写到三点", ref: "reply-4" }];
  const lines = cardCandidates([
    hypothesis({ id: "h1", dimension: "D2", cardKey: "s#2", rated: "partial", basis: two }),
    hypothesis({ id: "h2", dimension: "D2", basis: two }),
    hypothesis({ id: "h3", dimension: "D5", basis: two }),
    hypothesis({ id: "h4", dimension: "D5", basis: [two[0]!, { ...two[0]!, kind: "behavior" }] }),
    hypothesis({ id: "h5", dimension: "D1", basis: two, status: "refuted" }),
    hypothesis({ id: "h6", dimension: "D7", basis: two, status: "supported" })]);
  // h1 was asked, h4 rests on one reply with no competing explanation, h5 is refuted; h6 the extraction marked supported, which the
  // person has not seen (replay 13). D5 and D7 have had no card, D2 one.
  expect(lines).toEqual(["h3 [D5] 被看见时更投入（依据 reply-2「有人看的时候我做得更快」、reply-4「交给导师前一晚写到三点」）",
    "h6 [D7] 被看见时更投入（依据 reply-2「有人看的时候我做得更快」、reply-4「交给导师前一晚写到三点」）",
    "h2 [D2] 被看见时更投入（依据 reply-2「有人看的时候我做得更快」、reply-4「交给导师前一晚写到三点」）"]);
  // Fewer than the limit on two replies: an uncertain one on one reply with a competing explanation fills in, and the card asks which.
  const unsure = cardCandidates([hypothesis({ id: "h2", dimension: "D2", basis: two }), hypothesis({ id: "h8", dimension: "D5", alternative: "只是那周事多" }),
    hypothesis({ id: "h9", dimension: "D5" })]);
  expect(unsure).toHaveLength(2);
  expect(unsure[1]).toMatch(/^h8 .*待核实，只有一条回复.*被看见时更投入 \/ 只是那周事多$/);
  // The dialogue may only card these ids (cards ready together come in one round, 2026-11-14).
  expect(cardCandidateIds([hypothesis({ id: "h2", dimension: "D2", basis: two }), hypothesis({ id: "h3", dimension: "D5", basis: two }),
    hypothesis({ id: "h4", dimension: "D5", basis: two, cardKey: "s#4.1" })], 4)).toEqual(["h2", "h3"]);
  // The competing explanation goes with it, so the card can leave the why open.
  expect(cardCandidates([hypothesis({ id: "h7", dimension: "D2", basis: two, alternative: "截止临近才快" })])[0]).toMatch(/；另一种解释：截止临近才快$/);
});

test("the extraction's new hypotheses are numbered after the log's h ids, never as a card's, and the careers follow", () => {
  const out = numberNewHypotheses([hypothesis({ id: "h2" }), hypothesis({ id: "c5" })],
    [hypothesis({ id: "c5", status: "supported" }), hypothesis({ id: "c33" }), hypothesis({ id: "h9" })], [{ hypothesisIds: ["c33", "c5"] }]);
  expect(out.hypotheses.map((item) => item.id)).toEqual(["c5", "h3", "h4"]);
  expect(out.careers).toEqual([{ hypothesisIds: ["h3", "c5"] }]);
});
