import { beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "./index";

const WORKSPACE = "workspace-1";
const OWNER = "owner-1";
let store: CrosslineStore;

const evidence = [{ uri: "https://example.org/guide", source: "Guide", observedAt: "2026-09-16" }];
const relation = (id: string, overrides: Record<string, unknown> = {}) => ({
  id, ownerId: OWNER, workspaceId: WORKSPACE,
  fromMilestoneId: "m1", toMilestoneId: "m2", kind: "reuses" as const, status: "candidate" as const,
  evidence, explanation: "m1 的产出可以直接被 m2 复用。", refutedWhen: "m2 改变素材要求时不成立。",
  ...overrides
});

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  for (const id of ["m1", "m2"]) {
    store.saveMilestone({ id, ownerId: OWNER, workspaceId: WORKSPACE, identityId: "research",
      projectId: "p", title: id, version: 1, status: "approved" });
  }
});

test("a relation carries the claim it makes and what would refute it", () => {
  store.saveMilestoneRelation(relation("r1"));
  const stored = store.listMilestoneRelations(WORKSPACE)[0];
  expect(stored?.explanation).toBe("m1 的产出可以直接被 m2 复用。");
  expect(stored?.refutedWhen).toBe("m2 改变素材要求时不成立。");
});

test("a seed relation with no stated claim stays null instead of being given an invented one", () => {
  store.saveMilestoneRelation({ id: "r-seed", ownerId: OWNER, workspaceId: WORKSPACE,
    fromMilestoneId: "m1", toMilestoneId: "m2", kind: "informs", status: "candidate" });
  expect(store.listMilestoneRelations(WORKSPACE)[0]?.explanation).toBeNull();
});

test("a batch approval moves only the candidates and records one event", () => {
  store.saveMilestoneRelation(relation("r1"));
  store.saveMilestoneRelation(relation("r2"));
  const result = store.decideMilestoneRelations(WORKSPACE, ["r1", "r2"], "approved", "batch-1");
  expect(result).toEqual({ decided: ["r1", "r2"], skipped: [] });
  expect(store.listMilestoneRelations(WORKSPACE).map((item) => item.status)).toEqual(["approved", "approved"]);
  expect(store.listEvents("workspace-1").filter((event) => event.type === "milestone_relations.decided")).toHaveLength(1);
});

test("a decision already made is never silently re-decided", () => {
  store.saveMilestoneRelation(relation("approved-already", { status: "approved" }));
  store.saveMilestoneRelation(relation("refuted-already", { status: "refuted" }));
  store.saveMilestoneRelation(relation("still-candidate"));
  const result = store.decideMilestoneRelations(WORKSPACE, ["approved-already", "refuted-already", "still-candidate", "missing"], "archived", "batch-2");
  // Re-deciding settled relations in a batch would make the whole review untrustworthy, and reporting
  // them as decided would tell the person their click did something it did not.
  expect(result.decided).toEqual(["still-candidate"]);
  expect(result.skipped).toEqual(["approved-already", "refuted-already", "missing"]);
  const byId = new Map(store.listMilestoneRelations(WORKSPACE).map((item) => [item.id, item.status]));
  expect(byId.get("approved-already")).toBe("approved");
  expect(byId.get("refuted-already")).toBe("refuted");
});

test("a relation with no evidence cannot be approved into one that decides things", () => {
  store.saveMilestoneRelation(relation("no-evidence", { evidence: [] }));
  const approve = store.decideMilestoneRelations(WORKSPACE, ["no-evidence"], "approved", "batch-3");
  expect(approve).toEqual({ decided: [], skipped: ["no-evidence"] });
  // Archiving it is still allowed: declining a suggestion needs no evidence.
  expect(store.decideMilestoneRelations(WORKSPACE, ["no-evidence"], "archived", "batch-4").decided)
    .toEqual(["no-evidence"]);
});
