import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createInputRouter } from "./input-router";
import { fakeRuntime } from "./testing/fake-runtime";

test("an instruction about an open task comes back as a change; anything else as a capture", async () => {
  const store = new CrosslineStore(":memory:");
  store.saveWorkOrder({ id: "hw2", ownerId: "o", workspaceId: "w", identityId: "research", projectId: "ece555", milestoneId: "m", intent: "完成 ECE 555 作业 2",
    state: "approved", riskTier: "milestone", estimate: { p25Minutes: 60, p50Minutes: 120, p85Minutes: 240, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: {} });
  const answer = { items: [
    { kind: "schedule", title: "", context: "", workOrderId: "hw2", change: { type: "due", date: "2026-10-16", minutes: 0 }, summary: "ECE 555 作业 2 截止改为 10/16" },
    { kind: "capture", title: "买打印纸", context: "", workOrderId: "", change: { type: "none", date: "", minutes: 0 }, summary: "" }] };
  const runtime = fakeRuntime([JSON.stringify(answer)], "crossline:crossline-input-router");
  const route = createInputRouter(store, "w", "C:\\repo", () => runtime.rpc);
  const routed = await route({ text: "作业 2 推到 16 号；买打印纸", batch: true, mentions: [], timeZone: "America/Chicago" });
  expect(routed.routed).toBe(true);
  expect(routed.items.map((item) => item.kind)).toEqual(["schedule", "capture"]);
  expect(routed.items[0]!.change).toEqual({ type: "due", date: "2026-10-16", minutes: 0 });
  // The router only reads: nothing in the ledger changed.
  expect(store.listEvents("w")).toHaveLength(0);
  store.close();
});

test("without the runtime the text is kept as one capture", async () => {
  const store = new CrosslineStore(":memory:");
  const routed = await createInputRouter(store, "w", "C:\\repo", () => undefined)({ text: "把复习挪到周五", batch: false, mentions: [], timeZone: "UTC" });
  expect(routed).toMatchObject({ routed: false, items: [{ kind: "capture", title: "把复习挪到周五" }] });
  store.close();
});

test("every kind the router's instructions ask for can be returned under the schema, and the validator keeps each", async () => {
  const { readFileSync } = await import("node:fs");
  const { INPUT_ROUTE_SCHEMA } = await import("@crossline/core");
  const skill = readFileSync(new URL("../../../skills/marketplace/plugins/crossline/skills/crossline-input-router/SKILL.md", import.meta.url), "utf8");
  const asked = new Set([...skill.matchAll(/kind: "([a-z]+)"/g)].map((match) => match[1]!));
  const schema = INPUT_ROUTE_SCHEMA as unknown as { properties: { items: { items: { properties: { kind: { enum: string[] } } } } } };
  const allowed = schema.properties.items.items.properties.kind.enum;
  // The instructions named `event` and `profile` while the schema left them out: strict decoding could never return either.
  expect([...asked].filter((kind) => !allowed.includes(kind))).toEqual([]);
  expect(asked.has("event") && asked.has("profile")).toBe(true);
});
