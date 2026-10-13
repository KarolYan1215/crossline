import { afterAll, expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { solveInThread, stopSolverThread } from "./solver-pool";

const MODEL = ["Maximize", "obj: x + 2 y", "Subject To", "c1: x + y <= 4", "Bounds", "0 <= x <= 3", "0 <= y <= 1", "End"].join("\n");

afterAll(() => stopSolverThread());

test("a model solved on the thread comes back optimal, and a terminated thread is started again on the next call", async () => {
  const first = await solveInThread(MODEL, 5);
  expect(first.Status).toBe("Optimal");
  expect(first.ObjectiveValue).toBe(5);
  await stopSolverThread();
  expect((await solveInThread(MODEL, 5)).Status).toBe("Optimal");
}, 30_000);
