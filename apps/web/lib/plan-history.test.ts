import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { archivedBySystem, milestonesRetiredBySystem, saveMilestoneEdit } from "./crossline";
import { countPending } from "./pending";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

// The real account had 39 archived milestones, every one a draft the architect replaced on its own, all listed under 已归档.
test("drafts the architect replaced on its own are not shown; what the person archived is", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const save = (id: string, status: "draft" | "approved" | "archived") => store.saveMilestone({ id, ownerId: TEST_CTX.principalId,
    workspaceId: TEST_CTX.workspaceId, identityId: "research", projectId: "p", title: `里程碑 ${id}`, status, version: 1 });
  save("replaced", "archived");
  save("mine", "approved");
  expect(saveMilestoneEdit(TEST_CTX, { id: "mine", identityId: "research", projectId: "p", title: "里程碑 mine", status: "archived",
    successCriteria: [] } as never)).toMatchObject({ ok: true });
  expect([...milestonesRetiredBySystem(TEST_CTX)]).toEqual(["replaced"]);
});

test("the system's own withdrawals are recognised, old ones by their reason", () => {
  expect(archivedBySystem({ reason: "示例作业自动清理：你已经有自己的任务了" })).toBe(true);
  expect(archivedBySystem({ reason: "自动反推旧版一次给出整条链；现改为每轮只排接下来两步" })).toBe(true);
  expect(archivedBySystem({ reason: "随便写的", bySystem: true })).toBe(true);
  expect(archivedBySystem({ reason: "这个不做了" })).toBe(false);
});

test("candidate relations wait for the weekly review and are not counted as today's decisions", () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveMilestoneRelation({ id: "r1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, fromMilestoneId: "a", toMilestoneId: "b",
    kind: "informs", status: "candidate", evidence: [] } as never);
  const pending = countPending(TEST_CTX);
  expect(pending.relations).toBe(1);
  expect(pending.total).toBe(0);
});
