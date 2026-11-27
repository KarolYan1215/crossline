import { expect, test } from "vitest";
import { EVENT_TYPES } from "../packages/core/src/event-types";
import { reviewSources } from "./ledger-review";

test("an event kind or setting nothing reads is a candidate; one read anywhere is not; the counts come from the registry", () => {
  const review = reviewSources([
    `store.appendEvent({ idempotencyKey: "a", type: "mail.changed", entityId: id, payload: { change: "reply_drafted" } });
     store.appendEvent({ idempotencyKey: "b", type: "mail.changed", entityId: id, payload: { change: "sent_seen" } });
     store.appendEvent({ idempotencyKey: "c", type: "job.ran", entityId: id, payload: { job: "date.advance", state: "done" } });
     export const QUIET_SETTING = "quiet.thing";
     export const USED_SETTING = "used.thing";
     store.setSetting(ws, QUIET_SETTING, "1");
     store.setSetting(ws, USED_SETTING, "1");
     store.setSetting(ws, "literal.only", "1");`,
    `listEvents(ws, { type: "mail.changed", change: ["sent_seen"] });
     readJson(store.getSetting(ws, USED_SETTING));`
  ]);
  expect(review.writeOnlyEvents).toEqual(["job.ran:date.advance", "mail.changed:reply_drafted"]);
  expect(review.unwrittenEvents).toContain("mail.changed:reply_closed");
  expect(review.unwrittenEvents).not.toContain("mail.changed:sent_seen");
  expect(review.eventTypes).toBe(EVENT_TYPES.length);
  expect(review.writeOnlySettings).toEqual(["literal.only", "quiet.thing"]);
});
