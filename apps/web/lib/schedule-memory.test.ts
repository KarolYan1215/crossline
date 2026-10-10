import { expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { stepStartsOf } from "./schedule-memory";

// 「自动交给 Agent」 reads where each step's next block starts; the schedule itself is never stored, so this is the worker's only view of it.
test("each step's earliest block in the coming week, as an instant; whole-task blocks, other days and other kinds are left out", () => {
  const toInstant = (day: string, time: string) => `${day}T${time}:00.000Z`;
  const starts = stepStartsOf([
    { id: "scheduled:wo-1:v2s3:1", day: "2026-10-13", start: "14:00" },
    { id: "scheduled:wo-1:v2s3:0", day: "2026-10-12", start: "16:00" },
    { id: "scheduled:wo-1:v2s4", day: "2026-10-14", start: "09:00" },
    { id: "scheduled:wo-2:1", day: "2026-10-12", start: "10:00" },
    { id: "scheduled:wo-3:v1s1", day: "2026-10-11", start: "10:00" },
    { id: "scheduled:wo-3:v1s2", day: "2026-10-19", start: "10:00" },
    { id: "optional:wo-4:v1s1", day: "2026-10-12", start: "22:00" },
    { id: "graph_calendar:abc", day: "2026-10-12", start: "09:00" }
  ], "2026-10-12", "2026-10-19", toInstant);
  expect(starts).toEqual({ "wo-1#v2s3": "2026-10-12T16:00:00.000Z", "wo-1#v2s4": "2026-10-14T09:00:00.000Z" });
});

test("a block whose local time does not exist (a clock change) is skipped rather than guessed", () => {
  expect(stepStartsOf([{ id: "scheduled:wo-1:v1s1", day: "2026-10-12", start: "02:30" }], "2026-10-12", "2026-10-19", () => undefined)).toEqual({});
});
