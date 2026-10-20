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
  // A reply in the interview and a goal adopted are the person acting too; the interviewer's own turn is not.
  store.appendOnboardingMessage({ sessionId: "s", workspaceId: "w", role: "assistant", content: {}, createdAt: "2026-10-05T09:00:00.000Z" });
  expect(store.lastPersonActivity("w")).toBe("2026-10-03T09:00:00.000Z");
  store.appendOnboardingMessage({ sessionId: "s", workspaceId: "w", role: "user", content: { text: "a" }, createdAt: "2026-10-04T09:00:00.000Z" });
  expect(store.lastPersonActivity("w")).toBe("2026-10-04T09:00:00.000Z");
  store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: "goal", type: "line.updated", entityId: "media", payload: {} });
  expect(store.lastPersonActivity("w")! > "2026-10-04T09:00:00.000Z").toBe(true);
  store.close();
});

test("an undoable change made on a page and an undo are the person acting; the worker's own ops are not", async () => {
  const { CrosslineStore } = await import("./index");
  const store = new CrosslineStore(":memory:");
  store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: "op.applied:merge", type: "op.applied", entityId: "op-1",
    payload: { label: "合并", inverse: { kind: "task.unmerge" } } });
  store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: "op.applied:repair", type: "op.applied", entityId: "op-2",
    payload: { bySystem: true, label: "解除锁定", inverse: { kind: "settings.restore", entries: [] } } });
  expect(store.lastPersonActivity("w")).toBeUndefined();
  store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: "op.applied:shares", type: "op.applied", entityId: "op-3",
    payload: { label: "修改主线份额", inverse: { kind: "settings.restore", entries: [] } } });
  const after = store.lastPersonActivity("w");
  expect(after).toBeDefined();
  store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: "op.undone:op-3", type: "op.undone", entityId: "op-3", payload: {} });
  expect(store.lastPersonActivity("w")! >= after!).toBe(true);
  store.close();
});
