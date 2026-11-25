import { expect, test } from "vitest";
import { isSystemReport, pushPolicyOf } from "./push-policy";

test("only what needs the person now interrupts; account-security mail always does; the rest is listed (2026-11-20, A1–A4)", () => {
  for (const kind of ["block_start", "block_confirm", "latest_start", "timer_overrun", "reminder", "departure", "automation_remind", "form_computer"])
    expect(pushPolicyOf(kind)).toBe("interrupt");
  expect(pushPolicyOf("mail_check")).toBe("always");
  for (const kind of ["auto_answered", "auto_closed", "date_advance", "background_done", "day_wrap", "energy_check", "opportunity_form", undefined])
    expect(pushPolicyOf(kind)).toBe("list");
});

test("the brief's collected line counts what the system did, not questions waiting in the helper", () => {
  expect(isSystemReport("auto_answered")).toBe(true);
  expect(isSystemReport("date_advance")).toBe(true);
  expect(isSystemReport("energy_check")).toBe(false);
  expect(isSystemReport("day_wrap")).toBe(false);
  expect(isSystemReport("block_start")).toBe(false);
});
