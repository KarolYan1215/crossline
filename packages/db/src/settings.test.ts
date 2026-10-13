import { expect, test } from "vitest";
import { CrosslineStore } from "./index";

test("consent is three-valued: never asked is not the same as declined", () => {
  const store = new CrosslineStore(":memory:");
  try {
    expect(store.getSetting("w", "localActivity.consent")).toBeUndefined();
    store.setSetting("w", "localActivity.consent", "denied");
    expect(store.getSetting("w", "localActivity.consent")).toBe("denied");
    store.setSetting("w", "localActivity.consent", "granted");
    expect(store.getSetting("w", "localActivity.consent")).toBe("granted");
    // Consent travels with a backup, so a restore cannot quietly re-enable collection.
    expect(store.exportSnapshot("w").tables.settings)
      .toEqual([expect.objectContaining({ key: "localActivity.consent", value: "granted" })]);
  } finally { store.close(); }
});

test("the person's latest own action: what they said, timed, answered or reported, never what the system did", async () => {
  const { CrosslineStore } = await import("./index");
  const store = new CrosslineStore(":memory:");
  expect(store.lastPersonActivity("w")).toBeUndefined();
  store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: "sys", type: "manualbook.built", entityId: "x", payload: {} });
  store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: "agent-step", type: "task.step_progress", entityId: "x", payload: { source: "agent" } });
  expect(store.lastPersonActivity("w")).toBeUndefined();
  store.appendConversationMessage({ id: "m1", workspaceId: "w", conversationId: store.conversationFor("w", "2026-10-01").id, role: "person", text: "hi",
    payload: {}, createdAt: "2026-10-01T12:00:00.000Z" });
  expect(store.lastPersonActivity("w")).toBe("2026-10-01T12:00:00.000Z");
  store.saveEnergyObservation({ id: "e1", ownerId: "o", workspaceId: "w", source: "self_report", level: "high", confidence: "high", aggregate: {}, observedAt: "2026-10-03T09:00:00.000Z" });
  expect(store.lastPersonActivity("w")).toBe("2026-10-03T09:00:00.000Z");
  store.close();
});
