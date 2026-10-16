import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { LocaleProvider } from "../locale-context";
import { ReturnPanel, absenceSummary } from "./return-panel";

const steps = [{ id: "v1s1", title: "Derive questions 1–2", done: false }, { id: "v1s2", title: "Derive questions 3–4", done: false }];
const item = { key: "hw3#v1s1", orderId: "hw3", stepId: "v1s1", title: "ECE 555 homework 3", step: "Derive questions 1–2", line: "research", lineLabel: "Researcher",
  plannedDays: ["2026-10-11", "2026-10-12"], dueDay: "2026-10-14", p50Minutes: 60, lastStep: false, steps };
const view = { since: "2026-10-10T07:49:00.000Z", sinceDay: "2026-10-10", daysAway: 3, hoursAway: 75, items: [item],
  happened: { assistantDone: 1, proposals: 0, calendarChanges: 2, deadlinesSoon: [{ title: "ECE 548 midterm", deadline: "2026-10-27" }] },
  stale: { orders: [], milestones: [] } };

test("coming back is said in English, with plurals", () => {
  expect(absenceSummary(view, "en")).toEqual(["You were away 3 days (last action 10/10).",
    "Meanwhile 1 step was scheduled or came due. Settle it below with a tap, or say it in your own words.",
    "1 item due in the next 7 days, on 10/27:", "The assistant finished 1 piece of preparation meanwhile.", "Your calendar changed 2 times, and the schedule followed."]);
  expect(absenceSummary({ ...view, daysAway: 0, hoursAway: 1 }, "en")[0]).toBe("Your last action was 1 hour ago (10/10).");
});

test("each step's answers are English", () => {
  const html = renderToStaticMarkup(<LocaleProvider locale="en"><ReturnPanel view={view} /></LocaleProvider>);
  for (const label of ["Done", "Partly done", "Not done, roll over", "Drop it", "Say how far this step got", "Any other progress?", "Skip this time"]) expect(html).toContain(label);
  expect(html).toContain(" · scheduled 10/11, 10/12 · due 10/14");
});
