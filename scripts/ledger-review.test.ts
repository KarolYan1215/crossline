import { expect, test } from "vitest";
import { reviewSources } from "./ledger-review";

test("an event type or setting nothing reads is a candidate; one read anywhere, or by prefix, is not", () => {
  const review = reviewSources([
    `store.appendEvent({ idempotencyKey: "a", type: "mail.reply.drafted", entityId: id });
     store.appendEvent({ idempotencyKey: "b", type: "task.merged", entityId: id });
     store.appendEvent({ idempotencyKey: "c", type: "plan.version_archived", entityId: id });
     export const QUIET_SETTING = "quiet.thing";
     export const USED_SETTING = "used.thing";
     store.setSetting(ws, QUIET_SETTING, "1");
     store.setSetting(ws, USED_SETTING, "1");
     store.setSetting(ws, "literal.only", "1");`,
    `listEvents(ws, { type: "task.merged" });
     events.filter((e) => e.type.startsWith("plan."));
     readJson(store.getSetting(ws, USED_SETTING));`
  ]);
  expect(review.writeOnlyEvents).toEqual(["mail.reply.drafted"]);
  expect(review.writeOnlySettings).toEqual(["literal.only", "quiet.thing"]);
});
