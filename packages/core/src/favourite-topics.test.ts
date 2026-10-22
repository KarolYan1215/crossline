import { expect, test } from "vitest";
import {
  FAVOURITE_TOPICS_SCHEMA, dayBatch, emptyTopicPlan, mergeTopics, nightBatch, nightOf, parseTopicPlan, structuredOutputProblems, topicProgress, validateFavouriteTopics,
  withTopicSettings
} from "./index";

/** Favourites by topic (2026-10-22): a topic a day up to the day's share, and through the night window with no count. */
test("an answer keeps known numbers once each, and later answers extend topics by name", () => {
  expect(structuredOutputProblems(FAVOURITE_TOPICS_SCHEMA)).toEqual([]);
  const answer = validateFavouriteTopics({ topics: [{ name: "小红书爆款开头", why: "开头写法", notes: [1, 2, 2, 9] }, { name: "咖啡", why: "", notes: [3] }, { name: "空", why: "", notes: [] }] }, 3);
  expect(answer.topics).toEqual([{ name: "小红书爆款开头", why: "开头写法", notes: [1, 2] }, { name: "咖啡", why: "", notes: [3] }]);
  let plan = mergeTopics(emptyTopicPlan(), answer, ["a", "b", "c"]);
  plan = mergeTopics(plan, { topics: [{ name: "咖啡", why: "", notes: [1] }, { name: "美股", why: "", notes: [2] }] }, ["d", "e"]);
  expect(plan.topics.map((topic) => [topic.id, topic.name, topic.notes])).toEqual([["t1", "小红书爆款开头", ["a", "b"]], ["t2", "咖啡", ["c", "d"]], ["t3", "美股", ["e"]]]);
  expect(plan.order).toEqual(["t1", "t2", "t3"]);
  expect(plan.classified.sort()).toEqual(["a", "b", "c", "d", "e"]);
  expect(() => validateFavouriteTopics({ topics: [] }, 2)).toThrow("FAVOURITE_TOPICS_EMPTY");
});

test("by day one topic up to the share, a larger topic over several days; by night everything in order", () => {
  const notes = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const plan = { ...emptyTopicPlan(), perDay: 50, topics: [{ id: "t1", name: "A", why: "", notes: notes("a", 70) }, { id: "t2", name: "B", why: "", notes: notes("b", 10) }],
    order: ["t1", "t2"] };
  const first = dayBatch(plan, "2026-10-23", new Set());
  expect([first.topic?.id, first.ids.length]).toEqual(["t1", 50]);
  // Twenty already read today: thirty left of the share.
  const later = dayBatch({ ...plan, days: { "2026-10-23": { topicId: "t1", read: notes("a", 20) } } }, "2026-10-23", new Set(notes("a", 20)));
  expect(later.ids).toHaveLength(30);
  // The next day the rest of the big topic, not the next topic.
  const read = new Set(notes("a", 50));
  expect(dayBatch(plan, "2026-10-24", read).ids).toEqual(notes("a", 70).slice(50));
  // A topic finished early: the rest of the day's share is unused.
  expect(dayBatch({ ...plan, days: { "2026-10-25": { topicId: "t1", read: [] } } }, "2026-10-25", new Set(notes("a", 70))).ids).toEqual([]);
  // The night: every unread note, topic after topic.
  expect(nightBatch(plan, read)).toEqual([...notes("a", 70).slice(50), ...notes("b", 10)]);
  expect(topicProgress(plan, read)).toEqual([{ id: "t1", name: "A", total: 70, read: 50 }, { id: "t2", name: "B", total: 10, read: 0 }]);
});

test("the night window is read in the person's zone, and both paces are the person's to change", () => {
  const window = { from: 2, to: 8 };
  // 03:30 in Chicago (UTC-5 on 2026-10-23).
  const night = nightOf(new Date("2026-10-23T08:30:00Z"), "America/Chicago", window);
  expect(night.inWindow).toBe(true);
  expect(night.day).toBe("2026-10-23");
  expect(night.endsAt.toISOString()).toBe("2026-10-23T13:00:00.000Z");
  expect(nightOf(new Date("2026-10-23T15:00:00Z"), "America/Chicago", window).inWindow).toBe(false);
  // A window across midnight, and none at all.
  expect(nightOf(new Date("2026-10-23T04:30:00Z"), "America/Chicago", { from: 22, to: 6 }).inWindow).toBe(true);
  expect(nightOf(new Date("2026-10-23T08:30:00Z"), "America/Chicago", { from: 3, to: 3 }).inWindow).toBe(false);
  const changed = withTopicSettings(emptyTopicPlan(), { perDay: 30, from: 1, to: 7 });
  expect([changed.perDay, changed.window]).toEqual([30, { from: 1, to: 7 }]);
  expect(withTopicSettings(changed, { perDay: 0, from: 25 })).toMatchObject({ perDay: 30, window: { from: 1, to: 7 } });
  expect(parseTopicPlan(JSON.stringify({ perDay: 20 }))).toMatchObject({ perDay: 20, window: { from: 2, to: 8 }, days: {} });
  expect(parseTopicPlan(null)).toBeUndefined();
});
