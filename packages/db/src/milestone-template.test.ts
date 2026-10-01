import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "./index";

let store: CrosslineStore;
beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

const template = (id: string, identityId = "research") => ({
  id, workspaceId: "w1", kind: "deliverable" as const, identityId, titleHint: "综述完成",
  successCriteriaDefaults: [{ id: "c1", statement: "综述存在", required: true, evidenceOf: "output" as const,
    measure: { kind: "artifact" as const, mustExist: "综述文档" } }],
  evidenceQuestionDefaults: [{ id: "t-q1", prompt: "产出物是否存在？", kind: "checkbox" as const, options: ["是", "否"], required: true }],
  source: "builtin" as const
});

test("saveMilestoneTemplate writes a template that listMilestoneTemplates reads back whole", () => {
  store.saveMilestoneTemplate(template("t1"));
  const rows = store.listMilestoneTemplates("w1");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    id: "t1", kind: "deliverable", identityId: "research", titleHint: "综述完成", source: "builtin"
  });
  expect(rows[0]!.successCriteriaDefaults).toEqual(template("t1").successCriteriaDefaults);
  expect(rows[0]!.evidenceQuestionDefaults).toEqual(template("t1").evidenceQuestionDefaults);
});

test("listMilestoneTemplates filters by identity when asked", () => {
  store.saveMilestoneTemplate(template("t1", "research"));
  store.saveMilestoneTemplate(template("t2", "startup"));
  expect(store.listMilestoneTemplates("w1", "research").map((t) => t.id)).toEqual(["t1"]);
  expect(store.listMilestoneTemplates("w1").map((t) => t.id).sort()).toEqual(["t1", "t2"]);
});

test("saveMilestoneTemplate upserts by (workspaceId, id) rather than duplicating", () => {
  store.saveMilestoneTemplate(template("t1"));
  store.saveMilestoneTemplate({ ...template("t1"), titleHint: "修改后的标题" });
  const rows = store.listMilestoneTemplates("w1");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.titleHint).toBe("修改后的标题");
});

test("templates are isolated per workspace", () => {
  store.saveMilestoneTemplate(template("t1"));
  expect(store.listMilestoneTemplates("other-workspace")).toEqual([]);
});

test("seedMilestoneTemplates is idempotent — a second call does not duplicate or overwrite a user's edit", () => {
  const defaults = [template("t1")];
  store.seedMilestoneTemplates("w1", defaults);
  // Simulate the user editing the seeded row afterward.
  store.saveMilestoneTemplate({ ...template("t1"), titleHint: "用户改过的标题", source: "user" });
  store.seedMilestoneTemplates("w1", defaults);
  const rows = store.listMilestoneTemplates("w1");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.titleHint).toBe("用户改过的标题");
});

test("StoredMilestone carries templateId and confidence through save and read", () => {
  store.saveMilestone({
    id: "m1", ownerId: "o", workspaceId: "w1", identityId: "research", projectId: "p",
    title: "测试里程碑", version: 1, status: "draft",
    successCriteria: [{ id: "c1", statement: "x", required: true, measure: { kind: "artifact", mustExist: "x" } }],
    templateId: "t1", confidence: "high"
  });
  const milestone = store.getMilestone("w1", "m1");
  expect(milestone).toMatchObject({ templateId: "t1", confidence: "high" });
});

test("a milestone saved with no template has neither field, not a defaulted value", () => {
  store.saveMilestone({
    id: "m2", ownerId: "o", workspaceId: "w1", identityId: "research", projectId: "p",
    title: "自由生成的里程碑", version: 1, status: "draft", successCriteria: []
  });
  const milestone = store.getMilestone("w1", "m2")!;
  expect("templateId" in milestone).toBe(false);
  expect("confidence" in milestone).toBe(false);
});
