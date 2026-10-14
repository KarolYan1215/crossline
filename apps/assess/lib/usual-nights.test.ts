import { expect, test } from "vitest";
import { nightsFromAnswers, rhythmFromAnswers } from "./usual-nights";

const answers = { workdays: 5, work: { sleep: "23:30", wake: "7:00" }, free: { sleep: "1:00", wake: "9:30" } };

test("two weeks of nights: workday times Monday to Friday, free-day times at the weekend, onset after midnight on the wake day", () => {
  const nights = nightsFromAnswers(answers, "2026-01-15");
  expect(nights).toHaveLength(14);
  // 2026-01-15 is a Thursday: a workday night from 23:30 the evening before.
  expect(nights.at(-1)).toMatchObject({ sleepAt: "2026-01-14T23:30:00.000Z", wakeAt: "2026-01-15T07:00:00.000Z" });
  // 2026-01-11 is a Sunday.
  expect(nights.find((night) => night.wakeAt.startsWith("2026-01-11"))).toMatchObject({ sleepAt: "2026-01-11T01:00:00.000Z", wakeAt: "2026-01-11T09:30:00.000Z" });
  for (const night of nights) expect(Date.parse(night.wakeAt)).toBeGreaterThan(Date.parse(night.sleepAt));
});

test("the usual day follows the answers: asleep at 3:00, a three-hour best window while awake, the medians as the usual night", () => {
  const rhythm = rhythmFromAnswers(answers);
  expect(rhythm.nights).toBe(14);
  expect(rhythm.sleep.to).toBe(7);
  expect(rhythm.curve.find((point) => point.hour === 3)!.value).toBeNull();
  expect(rhythm.peak.end - rhythm.peak.start).toBe(3);
  expect(rhythm.chronotype).not.toBeNull();
});
