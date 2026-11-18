import { expect, test } from "vitest";
import { goalSettingKey } from "@crossline/core";
import { CrosslineStore } from "./index";
import { dueDateReader, effectiveDueDate } from "./due-date";

test("a task is due on the earlier of its own day and its milestone's, the goal's deadline replacing the anchor's", () => {
  expect(effectiveDueDate("2026-11-20", undefined, undefined)).toBe("2026-11-20");
  expect(effectiveDueDate(undefined, undefined, "2026-11-21")).toBe("2026-11-21");
  expect(effectiveDueDate("2026-11-25", undefined, "2026-11-21")).toBe("2026-11-21");
  // The goal replaces the anchor: a milestone moved later does not keep its old day.
  expect(effectiveDueDate(undefined, "2026-12-01", "2026-11-21")).toBe("2026-12-01");
  expect(effectiveDueDate("soon", undefined, "")).toBeUndefined();
});

test("W-277: a task dated only through its milestone is read as due, as its task page shows it", () => {
  const store = new CrosslineStore(":memory:");
  const ws = store.createPrincipalWithWorkspace("u", "w").workspace.id;
  store.saveMilestoneAnchor({ workspaceId: ws, milestoneId: "m1", stage: 1, deadline: "2026-11-21", baseline: "", target: "", stakeholders: [], sourceFactIds: [],
    dependsOn: [], updatedAt: "2026-11-01T00:00:00Z" });
  const dueOf = dueDateReader(store, ws);
  expect(dueOf({ milestoneId: "m1", payload: {} })).toBe("2026-11-21");
  expect(dueOf({ milestoneId: "m1", payload: { dueDate: "2026-11-19" } })).toBe("2026-11-19");
  expect(dueOf({ milestoneId: "", payload: {} })).toBeUndefined();
  store.setSetting(ws, goalSettingKey("m1"), JSON.stringify({ confirmedDeadline: "2026-11-30" }));
  expect(dueDateReader(store, ws)({ milestoneId: "m1", payload: {} })).toBe("2026-11-30");
  store.close();
});
