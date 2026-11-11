import { expect, test } from "vitest";
import {
  PUSH_RELEVANCE, bestRelevance, classifyFind, mergeLineTags, migratedTags, opportunityTypeOf, overlapOf, pushable, relevanceOf, socialSigns, type LineBrief
} from "./opportunity-tags";
import { applyLess, emptyTuning, holdBack, undoLess } from "./opportunity-watches";

const research: LineBrief = { id: "research", name: "研究", goal: "博士期间在类脑计算方向发表顶会论文", milestones: [{ id: "ms-paper", title: "neuromorphic hardware paper to ISCA" }],
  watches: [{ title: "类脑硬件会议", query: "neuromorphic workshop call for papers" }] };
const startup: LineBrief = { id: "startup", name: "创业", goal: "结识早期投资人，完成种子轮", milestones: [{ id: "ms-seed", title: "seed round: meet 20 angel investors" }], watches: [] };
const lines = [research, startup];

test("relevance: the model's confidence, capped when the claim rests on nothing real or shares no word, raised by the line's own watch", () => {
  const text = "Neuromorphic Hardware Workshop\nIEEE\ncall for papers on neuromorphic hardware";
  expect(overlapOf(text, research)).toBeGreaterThan(0.5);
  expect(relevanceOf({ confidence: 0.9, anchors: ["ms-paper"], line: research, findText: text }).relevance).toBeGreaterThanOrEqual(0.9);
  // A milestone of another line, or none: the claim rests on nothing here.
  expect(relevanceOf({ confidence: 0.9, anchors: ["ms-seed"], line: research, findText: text })).toMatchObject({ anchors: [] });
  expect(relevanceOf({ confidence: 0.9, anchors: ["ms-seed"], line: research, findText: text }).relevance).toBeLessThan(PUSH_RELEVANCE);
  // Nothing shared with the line at all: capped even when anchored.
  expect(relevanceOf({ confidence: 0.95, anchors: ["goal"], line: startup, findText: "Mindful Mondays\nRec Well" }).relevance).toBeLessThan(0.5);
  // Through the line's own watch the watch is the anchor.
  expect(relevanceOf({ confidence: 0.6, anchors: [], line: research, findText: text, viaLine: "research" }).relevance).toBeGreaterThanOrEqual(PUSH_RELEVANCE);
});

test("a find serves several lines, ranked; unknown lines and weak claims are dropped", () => {
  const classified = classifyFind({ type: "competition", reason: "类脑硬件赛道和投资人路演", lines: [
    { lineId: "startup", confidence: 0.65, reason: "路演", anchors: ["ms-seed"] },
    { lineId: "research", confidence: 0.8, reason: "赛道", anchors: ["ms-paper"] },
    { lineId: "ghost", confidence: 1, reason: "", anchors: [] }] },
  { lines, title: "Badger Hacks 2026", organizer: "Badger Hacks", pageText: "neuromorphic hardware track; seed investors pitch round with angel investors" });
  expect(classified.type).toBe("competition");
  expect(classified.lines.map((tag) => tag.lineId)).toEqual(["research", "startup"]);
  expect(classified.lines.every((tag) => tag.relevance >= PUSH_RELEVANCE)).toBe(true);
  expect(classified.lowValue).toBeUndefined();
});

test("low-value social gatherings by their own words, Chinese and English; a competition with a mixer is still a competition", () => {
  for (const title of ["ECE GSA Winter Ball 2026", "CS Coffee Hour with Faculty", "WiC Mentor Mixer", "Grad Happy Hour at the Terrace", "研究生会新年社交酒会",
    "导师交流会：与校友导师面对面", "春季联谊舞会"]) expect(socialSigns(title), title).not.toEqual([]);
  for (const title of ["ISCA 2027 Call for Papers", "Badger Hacks 2026", "NSF GRFP Info Session", "Google Research Internship 2027", "类脑计算暑期学校"]) expect(socialSigns(title), title).toEqual([]);
  const ball = classifyFind({ type: "event", reason: "", lines: [{ lineId: "research", confidence: 0.7, reason: "同系", anchors: ["goal"] }] }, { lines, title: "ECE GSA Winter Ball 2026", organizer: "ECE GSA" });
  expect(ball).toMatchObject({ type: "social", lowValue: "social" });
  const hack = classifyFind({ type: "competition", reason: "", lines: [] }, { lines, title: "Hack Night + founders mixer", organizer: "Badger Hacks" });
  expect(hack.type).toBe("competition");
  expect(hack.lowValue).toBeUndefined();
});

test("a social gathering is kept when a line's goal is meeting people in its field", () => {
  const night = classifyFind({ type: "social", reason: "天使投资人到场", lines: [{ lineId: "startup", confidence: 0.85, reason: "种子轮", anchors: ["ms-seed"] }] },
    { lines, title: "Madison Founders & Angels Networking Night", organizer: "Madison Startups", pageText: "angel investors and seed funds" });
  expect(night.type).toBe("social");
  expect(night.lowValue).toBeUndefined();
  expect(pushable({ lineId: "startup", ...night })).toBe(true);
});

test("held back: a low-value gathering always; a quiet type unless very relevant; a quiet social type always", () => {
  const base = { url: "https://x.example.org/", kind: "event" as const, title: "Seminar", lineId: "research" };
  const verdict = { state: "eligible" };
  expect(holdBack({ opportunity: { ...base, lowValue: "social" }, verdict, tuning: emptyTuning() })).toBe("low_value_social");
  const tuning = { ...emptyTuning(), quietTypes: [{ id: "q1", type: "talk" as const }, { id: "q2", type: "social" as const }] };
  const tag = (relevance: number) => [{ lineId: "research", confidence: relevance, relevance, reason: "", anchors: [] }];
  expect(holdBack({ opportunity: { ...base, type: "talk", lines: tag(0.7) }, verdict, tuning })).toBe("quiet_type");
  expect(holdBack({ opportunity: { ...base, type: "talk", lines: tag(0.85) }, verdict, tuning })).toBeUndefined();
  expect(holdBack({ opportunity: { ...base, type: "social", lines: tag(0.95) }, verdict, tuning })).toBe("quiet_type");
});

test("少来这类 learns the type, and taking it back removes only that", () => {
  const t = (key: string, values?: Record<string, unknown>) => key.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ""));
  const applied = applyLess({ feedback: { opportunityId: "o1", scope: "kind" }, tuning: emptyTuning(), failedRules: [], id: "less-1", at: "2026-11-10T00:00:00Z", t,
    opportunity: { id: "o1", url: "https://cs.example.edu/coffee", title: "CS Coffee Hour", lineId: "research", kind: "event" } });
  expect(applied.tuning.quietTypes).toEqual([{ id: "less-1", type: "social" }]);
  expect(applied.entry.changes).toContain("社交类聚会以后不推");
  expect(undoLess(applied.entry, undefined, applied.tuning, "2026-11-11T00:00:00Z").tuning.quietTypes).toEqual([]);
});

test("rows read before tags: one migrated line at the push threshold, a type from the title; a later reading replaces the migrated tag", () => {
  const old = { lineId: "research", kind: "application" as const, title: "Google Research Internship 2027" };
  const tags = migratedTags(old);
  expect(tags).toMatchObject({ type: "internship", lines: [{ lineId: "research", relevance: PUSH_RELEVANCE, migrated: true }] });
  expect(bestRelevance({ lineId: "x" })).toBe(PUSH_RELEVANCE);
  expect(bestRelevance({ lineId: "x", lines: [] })).toBe(0);
  const merged = mergeLineTags({ ...old, ...tags }, { ...old, lines: [
    { lineId: "research", confidence: 0.4, relevance: 0.4, reason: "", anchors: [] }, { lineId: "startup", confidence: 0.7, relevance: 0.7, reason: "", anchors: [] }] });
  expect(merged.lines.map((tag) => [tag.lineId, tag.relevance])).toEqual([["startup", 0.7], ["research", 0.4]]);
  expect(merged.lineId).toBe("startup");
  expect(opportunityTypeOf({ kind: "event", title: "NSF GRFP Info Session seminar" })).toBe("talk");
});
