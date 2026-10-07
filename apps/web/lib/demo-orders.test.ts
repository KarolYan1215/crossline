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

// 「今天可用」 at 21:10 used to say 420 minutes: the whole day's pattern, no matter how much of it was over.
test("today's available minutes count only what is left from now", async () => {
  const { remainingMinutes } = await import("./crossline");
  const slots = [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }, { start: "19:30", end: "23:00" }];
  expect(remainingMinutes(slots, "08:00")).toBe(180 + 240 + 210);
  expect(remainingMinutes(slots, "21:10")).toBe(110);
  expect(remainingMinutes(slots, "15:00")).toBe(180 + 210);
  expect(remainingMinutes(slots, "23:30")).toBe(0);
});
