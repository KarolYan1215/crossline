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
