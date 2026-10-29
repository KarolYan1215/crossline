import { afterEach, expect, test, vi } from "vitest";
import { listenForPlanChanges, PLAN_CHANGED } from "./plan-refresh";

afterEach(() => { vi.useRealTimers(); });

test("a burst of plan-changed events redraws the page once, and nothing after clean-up (W-142)", () => {
  vi.useFakeTimers();
  const target = new EventTarget();
  const refresh = vi.fn();
  const stop = listenForPlanChanges(target, refresh);
  target.dispatchEvent(new Event(PLAN_CHANGED));
  target.dispatchEvent(new Event(PLAN_CHANGED));
  vi.advanceTimersByTime(200);
  expect(refresh).toHaveBeenCalledTimes(1);
  stop();
  target.dispatchEvent(new Event(PLAN_CHANGED));
  vi.advanceTimersByTime(200);
  expect(refresh).toHaveBeenCalledTimes(1);
});
