import { expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { interviewSetupDone, setupSteps, type ConnectionRow } from "./settings-status";

const t = (key: string) => key;
const row = (kind: ConnectionRow["kind"], state: ConnectionRow["state"]): ConnectionRow =>
  ({ id: kind, kind, label: kind, detail: "", state, status: "", action: { label: "", href: "#" } });

test("the setup steps come in the order worth doing them, the two the app needs first, each done from what is connected", () => {
  const steps = setupSteps(t, { rows: [row("mail", "off"), row("model", "warn"), row("push", "off"), row("health", "off")],
    modelConnected: false, interviewDone: false, hosted: true, computerLinked: false });
  expect(steps.map((step) => step.id)).toEqual(["model", "interview", "calendar", "push", "mail", "computer", "health"]);
  expect(steps.filter((step) => step.weight === "required").map((step) => step.id)).toEqual(["model", "interview"]);
  expect(steps.every((step) => !step.done)).toBe(true);
  // The interview is done on its own page; every other step lands on a card of this one.
  expect(steps.find((step) => step.id === "interview")?.href).toBe("/onboarding");
  expect(steps.filter((step) => step.id !== "interview").every((step) => step.href.startsWith("#"))).toBe(true);
});

test("an interview past its start bar counts as done for the guide, with questions still left", () => {
  expect(interviewSetupDone({ complete: false, ended: false, readyToStart: true })).toBe(true);
  expect(interviewSetupDone({ complete: false, ended: false, readyToStart: false })).toBe(false);
  expect(interviewSetupDone({ complete: false, ended: true, readyToStart: false })).toBe(true);
});

test("a subscription counts as the calendar, a broken mailbox is still connected, and steps that cannot apply are left out", () => {
  const steps = setupSteps(t, { rows: [row("subscription", "ok"), row("mail", "warn"), row("model", "ok"), row("health", "ok")],
    modelConnected: true, interviewDone: true, hosted: false, computerLinked: false });
  expect(steps.map((step) => step.id)).toEqual(["model", "interview", "calendar", "mail", "health"]);
  expect(steps.every((step) => step.done)).toBe(true);
});
