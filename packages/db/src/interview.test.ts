import { expect, test } from "vitest";
import { CrosslineStore, interviewChecklistFor } from "./index";

const lines = [{ id: "research", label: "研究者", hard: false, goals: [] }];
const startLine = (store: CrosslineStore) => interviewChecklistFor(store, "w", lines, { unfiledFiles: 0, today: "2026-11-22" }).find((item) => item.id === "start_line")!;

// S3's leftover (2026-11-22): an account that never named a line gets the built-in four from identity-packs, and those counted as
// 「至少有一条主线」. Only lines the person listed count now.
test("「至少有一条主线」 counts only lines the person listed, not the built-in ones that stand in without them", () => {
  const store = new CrosslineStore(":memory:");
  expect(startLine(store).done).toBe(false);
  store.setSetting("w", "lines.v1", JSON.stringify([{ id: "research", label: "研究者", color: "research" }]));
  expect(startLine(store).done).toBe(true);
  store.close();
});

// The owner's call (2026-11-22): an account in use before lines were listed is not sent back to the interview; the examples do not count.
test("an account with work of its own but no listed lines still has its line; the seeded examples alone do not give it one", () => {
  const store = new CrosslineStore(":memory:");
  const order = (id: string, payload: Record<string, unknown>) => store.saveWorkOrder({ id, ownerId: "o", workspaceId: "w", identityId: "research", projectId: "p", milestoneId: "m", intent: "x",
    state: "approved", riskTier: "routine", payload, estimate: { p25Minutes: 10, p50Minutes: 20, p85Minutes: 40, source: "llm_prior", observationCount: 0, confidence: "low" } });
  order("example", { seeded: true });
  expect(startLine(store).done).toBe(false);
  order("own", {});
  expect(startLine(store).done).toBe(true);
  store.close();
});
