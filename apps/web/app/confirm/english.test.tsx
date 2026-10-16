import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { LocaleProvider } from "../locale-context";
import { ConfirmForm } from "./confirm-form";

const view = { messageId: "m1", orderId: "ece555-hw3", title: "ECE 555 homework 3", step: "Derive questions 1–2", day: "2026-10-12", start: "09:00", end: "09:45",
  blockMinutes: 45, lastStep: true, milestoneBound: true };

test("the completion check is English on an English page", () => {
  const html = renderToStaticMarkup(<LocaleProvider locale="en"><ConfirmForm view={{ ...view, activityMinutes: 75 }} /></LocaleProvider>);
  for (const label of ["Done as estimated", "Took longer", "Took less", "Not done", "What you produced"]) expect(html).toContain(label);
  expect(html).toContain("10/12 09:00–09:45, estimated 45 min; this is the last step");
  expect(html).toContain("Screen record: about 1 h 15 min");
  const answered = renderToStaticMarkup(<LocaleProvider locale="en"><ConfirmForm view={{ ...view, lastStep: false, answered: { outcome: "over", minutes: 60 } }} /></LocaleProvider>);
  expect(answered).toContain("Recorded: 1 h spent, and this step is done.");
});
