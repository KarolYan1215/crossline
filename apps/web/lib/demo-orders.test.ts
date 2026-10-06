import { expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { withoutShadowingDemos } from "./crossline";

const order = (id: string, state: string, seeded = false, identityId = "research") => ({ id, state, identityId, payload: seeded ? { seeded: true } : {} });
const none = new Set<string>();

test("with no work of the person's own, the demo orders are still there to show the flow", () => {
  const orders = [order("research-starter-work-order", "active", true)];
  expect(withoutShadowingDemos(orders, none).map((item) => item.id)).toEqual(["research-starter-work-order"]);
});

test("once the person has work of their own, demo orders stop being recommended or scheduled", () => {
  const orders = [order("research-starter-work-order", "active", true), order("mine", "awaiting_plan_approval")];
  expect(withoutShadowingDemos(orders, none).map((item) => item.id)).toEqual(["mine"]);
});

test("a discarded order, or a health commitment, is not 'own work' and does not hide the demos", () => {
  const orders = [order("research-starter-work-order", "active", true), order("old", "archived"), order("sleep", "active", false, "health")];
  expect(withoutShadowingDemos(orders, new Set(["health"])).map((item) => item.id)).toEqual(["research-starter-work-order", "old", "sleep"]);
});
