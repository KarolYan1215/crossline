import { expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { validateCuratedArchetypes } from "@crossline/core";
import { curationDue } from "./archetype-curator";

const step = (id: string, role: string) => ({ id, role, title: id, deliverable: "", doneCriterion: "", share: 0.5,
  estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 45 }, dependsOn: [], notBefore: "", dueBy: "", schedulable: true, executor: "human" as const, tickOutcome: "" });

test("a curation is due on the period once there is history, early after twenty new preferences, never when switched off", () => {
  const store = new CrosslineStore(":memory:");
  const now = new Date("2026-10-08T12:00:00Z");
  expect(curationDue(store, "w", now)).toBe(false);
  for (let i = 0; i < 8; i += 1) store.saveStepPlan("w", `wo${i}`, { archetypeId: "writing", quantity: { basis: "字数", amount: 1, unit: "千字" }, rationale: "",
    steps: [step("a", "draft"), step("b", "check")] }, "o", "planned");
  expect(curationDue(store, "w", now)).toBe(true);
  store.appendEvent({ ownerId: "o", workspaceId: "w", idempotencyKey: "c1", type: "archetypes.curated", entityId: "w", payload: { added: [], dropped: [] } });
  expect(curationDue(store, "w", now)).toBe(false);
  for (let i = 0; i < 20; i += 1) store.addPreference({ workspaceId: "w", source: "correction", scope: "all", weight: 1, refId: "", text: `偏好 ${i} 条`, createdAt: "2099-01-01T00:00:00Z" });
  expect(curationDue(store, "w", now)).toBe(true);
  store.setSetting("w", "archetypes.curation.period", "off");
  expect(curationDue(store, "w", now)).toBe(false);
  store.close();
});

test("a proposed archetype is kept only with its own roles, the person's tasks and a source; anything else is dropped with a reason", () => {
  const good = { id: "lab_report", label: "实验报告", primitives: ["sequence", "checkpoint"], roles: ["gather", "build", "record", "draft", "check"],
    requires: ["record", "draft"], firstBefore: [["build", "record"]], endsWith: ["check"], proportions: [{ role: "draft", share: 0.4 }],
    quantify: { basis: "实验数", unit: "个", minutesLow: 60, minutesHigh: 180 }, acceptance: "实验报告评分量规", tickHint: "完成一节实验记录",
    agentRoles: ["gather"], recurring: false, basedOnTaskIds: ["t1", "t2"], sources: [{ url: "https://example.org/lab-report-guide", title: "指南" }], why: "反复出现" };
  const result = validateCuratedArchetypes({ archetypes: [good, { ...good, id: "writing" }, { ...good, id: "solo", basedOnTaskIds: ["t1"] },
    { ...good, id: "odd", firstBefore: [["build", "mock"]] }], notes: "" }, { existingIds: [], taskIds: ["t1", "t2"] });
  expect(result.kept.map((item) => item.id)).toEqual(["lab_report"]);
  expect(result.kept[0]!.quantify.minutesPerUnit).toEqual([60, 180]);
  // At most three are considered: the fourth is not read at all.
  expect(result.dropped).toHaveLength(2);
  expect(validateCuratedArchetypes({ archetypes: [{ ...good, id: "odd", firstBefore: [["build", "mock"]] }], notes: "" },
    { existingIds: [], taskIds: ["t1", "t2"] }).dropped[0]).toContain("先后规则");
});
