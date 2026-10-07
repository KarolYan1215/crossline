import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { personSnapshot, SNAPSHOT_LIMIT } from "./person-snapshot";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

// The point of the snapshot: 「我这周最该做什么」 can be answered from the person's own deadlines.
test("the snapshot names approved milestones with their deadline and days left, and drafts separately", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const save = (id: string, title: string, status: "approved" | "draft", deadline: string) => {
    store.saveMilestone({ id, ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, identityId: "research",
      projectId: "p", title, status, version: 1 });
    store.saveMilestoneAnchor({ workspaceId: TEST_CTX.workspaceId, milestoneId: id, stage: 1, deadline, baseline: "", target: "",
      stakeholders: [], sourceFactIds: [], dependsOn: [], updatedAt: "2026-10-01T00:00:00Z" });
  };
  save("mos2", "实测 MoS₂ 参数已可直接驱动 NeuroSim", "approved", "2026-10-12");
  save("paper", "西湖合作论文已在截止日前投出", "approved", "2026-10-31");
  save("exam", "ECE 548 期中考试 1 达到 A− 支撑线", "draft", "2026-10-27");
  store.saveWaitingItem({ id: "wait-1", ownerId: TEST_CTX.principalId, workspaceId: TEST_CTX.workspaceId, title: "真实测量数据", who: "师兄",
    expectedAt: "2026-10-08", approximate: true, followUpAt: "2026-10-08", state: "open", blocks: [], source: "manual" });
  const text = await personSnapshot(TEST_CTX, new Date("2026-10-06T17:00:00Z"));
  expect(text).toContain("师兄：真实测量数据 · 预计大约 2026-10-08");
  expect(text).toContain("实测 MoS₂ 参数已可直接驱动 NeuroSim · 最晚 2026-10-12（还剩 6 天）");
  expect(text.indexOf("2026-10-12")).toBeLessThan(text.indexOf("2026-10-31"));
  expect(text).toMatch(/草稿里程碑[\s\S]*ECE 548 期中考试 1/);
  expect(text.length).toBeLessThanOrEqual(SNAPSHOT_LIMIT);
});
