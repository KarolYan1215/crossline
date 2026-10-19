import { expect, test } from "vitest";
import { citationWarnings, citedSpan, keepOnboardingAnswer, numberedText, resolveDateRefs, validateOnboardingAnswer } from "./onboarding-refs";
import { segmentText } from "./sentences";
import type { EvidenceSentence, KnownSources } from "./onboarding-turn-schema";

// reply-1 is the person's line, src-1 a syllabus; sentences are numbered as the store would number them.
const replies = { "reply-1": "我9.00上课，周三下午3点组会。论文12月中投稿。把目标改成能独立立项的研究者" };
const sources = { "src-1": "Week-8: 27th Oct.\nL15: Mid-term-1\nFinal Project Report TBD" };
function known(): KnownSources {
  const sentences = new Map<number, EvidenceSentence>();
  let id = 1;
  for (const [ref, text] of Object.entries({ ...replies, ...sources })) for (const segment of segmentText(text)) sentences.set(id++, { ref, ...segment });
  return { identities: ["research"], projectIds: [], replies, sources, sentences };
}
const turn = (over: object = {}) => ({ reply: "好的", questions: [{ id: "q", text: "还有吗？", kind: "free", options: [], allowOther: true, identityId: "", projectId: "" }],
  slotUpdates: [], projectsDetected: [], flywheelCandidates: [], coverage: [], nextAction: "ask", stage: "orientation", lineProfiles: [], goalEdits: [],
  availability: { windows: [], why: "" }, ...over });
const fact = (over: object) => ({ identityId: "research", projectId: "", slot: "deadline", value: "12 月中", status: "confirmed", refs: [3], ...over });

test("the numbering a turn is given", () => {
  const index = known().sentences!;
  expect([...index.entries()].map(([id, entry]) => `${id}:${entry.ref}:${entry.text}`)).toEqual([
    "1:reply-1:我9.00上课，周三下午3点组会。", "2:reply-1:论文12月中投稿。", "3:reply-1:把目标改成能独立立项的研究者",
    "4:src-1:Week-8: 27th Oct.", "5:src-1:L15: Mid-term-1", "6:src-1:Final Project Report TBD"]);
  expect(numberedText([{ id: 4, text: "Week-8: 27th Oct." }, { id: 5, text: "L15: Mid-term-1" }])).toBe("[4] Week-8: 27th Oct.\n[5] L15: Mid-term-1");
});

test("a cited number becomes the person's own words; adjacent numbers become one span of the same source", () => {
  const index = known().sentences!;
  const texts = { ...replies, ...sources };
  expect(citedSpan([2], index, texts)).toMatchObject({ sourceRef: "reply-1", quote: "论文12月中投稿。", ids: [2] });
  expect(citedSpan([4, 5], index, texts)).toMatchObject({ sourceRef: "src-1", quote: "Week-8: 27th Oct.\nL15: Mid-term-1", refs: ["src-1"] });
  // Two sources: the quote is the first source's, every id is kept.
  expect(citedSpan([2, 4], index, texts)).toMatchObject({ sourceRef: "reply-1", quote: "论文12月中投稿。", ids: [2, 4], refs: ["reply-1", "src-1"] });
  expect(citedSpan([77, "x"], index, texts)).toMatchObject({ ids: [], unknown: [77] });
});

test("strict: a number the model was not shown, or a confirmed fact citing nothing, is refused in numbers it can act on", () => {
  const refused = (value: object) => { try { validateOnboardingAnswer(value, known()); return undefined; } catch (error) { return [(error as Error).message, (error as Error & { detail?: string }).detail]; } };
  expect(refused(turn({ slotUpdates: [fact({ refs: [99] })] }))).toEqual(["ONBOARDING_REF_UNKNOWN", expect.stringContaining("[99]")]);
  expect(refused(turn({ slotUpdates: [fact({ refs: [] })] }))?.[0]).toBe("ONBOARDING_REF_REQUIRED");
  // A guess may cite nothing.
  expect(validateOnboardingAnswer(turn({ slotUpdates: [fact({ status: "inferred", refs: [] })] }), known()).slotUpdates[0])
    .toMatchObject({ sourceRef: "inference", sourceQuote: "", sentences: [] });
  // A goal change must rest on the person's reply, not on a file.
  expect(refused(turn({ goalEdits: [{ lineId: "research", parts: [{ text: "能独立立项", kind: "ability" }], refs: [4] }] }))?.[0]).toBe("ONBOARDING_GOAL_EDIT_UNASKED");
  expect(validateOnboardingAnswer(turn({ goalEdits: [{ lineId: "research", parts: [{ text: "能独立立项", kind: "ability" }], refs: [3] }] }), known()).goalEdits)
    .toEqual([{ lineId: "research", parts: [{ text: "能独立立项", kind: "ability" }], sourceRef: "reply-1" }]);
});

test("after the repairs, an item citing an unknown number goes and the rest stays; times arrive as minutes", () => {
  const kept = keepOnboardingAnswer(turn({ slotUpdates: [fact({ refs: [99] }), fact({ slot: "class_time", value: "09:00", refs: [1] })],
    availability: { windows: [{ days: [1, 2], startMinute: 570, endMinute: 1440, energy: "high" }], why: "本人所述" } }), known())!;
  expect(kept.slotUpdates.map((update) => [update.slot, update.sourceQuote, update.sentences])).toEqual([["class_time", "我9.00上课，周三下午3点组会。", [1]]]);
  expect(kept.availability?.windows).toEqual([{ days: [1, 2], start: "09:30", end: "24:00", energy: "high" }]);
});

test("dates cite the row that holds the day; times are minutes or none", () => {
  const index = known().sentences!;
  const out = resolveDateRefs({ dates: [{ id: "d1", date: "2026-10-27", startMinute: 600, endMinute: null, kind: "exam", title: "期中", project: "", refs: [4, 5], confidence: "high", note: "" }],
    recurring: [{ id: "r1", title: "组会", project: "", weekdays: [3], startMinute: 900, endMinute: 960, from: "2026-10-01", to: "2026-12-31", exceptions: [], location: "", refs: [1], confidence: "high" }],
    questions: ["哪门课？"], undated: [{ id: "u1", kind: "project_due", title: "Final Project Report", project: "", refs: [6], note: "" }] }, index, { ...replies, ...sources });
  expect(out.dates[0]).toMatchObject({ startTime: "10:00", endTime: "", sourceRef: "src-1", quote: "Week-8: 27th Oct.\nL15: Mid-term-1" });
  expect(out.recurring[0]).toMatchObject({ startTime: "15:00", endTime: "16:00", sourceRef: "reply-1" });
  expect(out.undated?.[0]).toMatchObject({ sourceRef: "src-1", quote: "Final Project Report TBD" });
});

test("a confirmed fact whose numbers its sentences do not state is a warning, however the person typed the time", () => {
  const resolved = validateOnboardingAnswer(turn({ slotUpdates: [fact({ slot: "class", value: "09:00", refs: [1] }), fact({ slot: "meeting", value: "15:00", refs: [1] }),
    fact({ slot: "deadline", value: "2026-12-20", refs: [2] })] }), known());
  expect(citationWarnings(resolved)).toEqual([{ slot: "deadline", value: "2026-12-20", sentences: [2] }]);
});

test("a date citing sentences far apart keeps the one that holds its day", () => {
  const long = `Week-8: 27th Oct.\n${"Reading list and lecture notes for the week. ".repeat(20)}\nL15: Mid-term-1 on 29th Oct.`;
  const sentences = new Map<number, EvidenceSentence>();
  segmentText(long).forEach((segment, index) => sentences.set(index + 1, { ref: "src-1", ...segment }));
  const last = sentences.size;
  const out = resolveDateRefs({ dates: [{ id: "d", date: "2026-10-29", startMinute: null, endMinute: null, kind: "exam", title: "期中", project: "", refs: [1, last],
    confidence: "high", note: "" }], recurring: [], questions: [], undated: [] }, sentences, { "src-1": long });
  expect(out.dates[0]!.quote).toBe("L15: Mid-term-1 on 29th Oct.");
});
