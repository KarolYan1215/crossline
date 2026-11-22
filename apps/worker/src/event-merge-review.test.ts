import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { EVENT_MERGE_REVIEW, mergeCandidates, readMergeReview } from "@crossline/core";
import { eventMergeCandidates, eventMergeReviewPass, fixedItemsForReview } from "./event-merge-review";
import { scriptedRuntime } from "./testing/fake-runtime";

// 2026-11-22: code circles overlapping items whose titles share characters; the reviewer decides which are one thing, and only those
// (or the same title) reach the person. A lecture and the same course's office hours were merged by the old course-code rule.
test("the reviewer sees each circled pair once; only the pairs it calls the same are asked, the same title needs no review", async () => {
  const store = new CrosslineStore(":memory:"), ws = "ws";
  const block = (id: string, title: string) => ({ id, lane: "human", title, day: "2026-11-03", start: "11:00", end: "12:15", readOnly: true });
  store.savePlanVersion({ id: "p", ownerId: "o", workspaceId: ws, version: 1, status: "approved", createdAt: "2026-11-01T00:00:00Z",
    payload: { blocks: [block("graph_calendar:a", "ECE 555 Lecture"), block("import:b:m1:2026-11-03", "ECE 555 课堂"),
      block("import:b:m2:2026-11-03", "ECE 555 Office Hours"), block("event:e:2026-11-03", "ECE 555 lecture")] } } as never);
  const now = new Date("2026-11-02T12:00:00Z");
  expect(fixedItemsForReview(store, ws, now)).toHaveLength(4);
  const circled = eventMergeCandidates(store, ws, now);
  // The identical pair (Lecture / lecture) is not sent: it is asked without a review.
  expect(circled.some((pair) => [pair.a.title, pair.b.title].sort().join("|") === "ECE 555 Lecture|ECE 555 lecture")).toBe(false);
  const runtime = scriptedRuntime(["crossline:crossline-validation-reviewer"], (prompt) => {
    const ids = [...prompt.matchAll(/"id":\s*"(p\d+)"/g)].map((match) => match[1]!);
    return JSON.stringify({ pairs: ids.map((id) => {
      const pair = circled[Number(id.slice(1)) - 1]!;
      const titles = `${pair.a.title}|${pair.b.title}`;
      return { id, same: titles.includes("课堂") && titles.includes("Lecture") && !titles.includes("Office"), why: "x" };
    }) });
  });
  const same = await eventMergeReviewPass(store, ws, runtime.rpc, "C:\\repo", now);
  expect(same.length).toBeGreaterThan(0);
  const review = readMergeReview(store.getSetting(ws, EVENT_MERGE_REVIEW));
  expect(Object.keys(review)).toHaveLength(circled.length);
  expect(eventMergeCandidates(store, ws, now)).toEqual([]);
  const asked = mergeCandidates(fixedItemsForReview(store, ws, now), {}, review).map((pair) => [pair.a.title, pair.b.title].sort().join("|"));
  expect(asked).toContain("ECE 555 Lecture|ECE 555 lecture");
  expect(asked.some((titles) => titles.includes("Office"))).toBe(false);
  store.close();
});
