import { expect, test } from "vitest";
import { FIXED_EVENTS, MAIL_EVENTS_SETTING } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { briefIds, buildLedgerBrief } from "./ledger-brief";

const NOW = new Date("2026-11-10T09:00:00Z");

function setup() {
  const store = new CrosslineStore(":memory:");
  const { principal, workspace } = store.createPrincipalWithWorkspace("user-1", "w");
  const order = (id: string, intent: string, state = "approved", payload: Record<string, unknown> = {}) => store.saveWorkOrder({ id, ownerId: principal.id,
    workspaceId: workspace.id, identityId: "research", projectId: "", milestoneId: "m-ctrl", intent, state, riskTier: "routine",
    estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 60, source: "llm_prior", observationCount: 0, confidence: "low" }, payload } as never);
  store.saveMilestone({ id: "m-ctrl", ownerId: principal.id, workspaceId: workspace.id, identityId: "research", projectId: "p", title: "控制方向资格考", version: 1, status: "approved" });
  return { store, workspaceId: workspace.id, order };
}

test("the brief holds what the person already has: milestones, open and done tasks, 21 days of time with each weekly occurrence, mail events", () => {
  const { store, workspaceId, order } = setup();
  order("wo-hw4", "完成 ECE 555 作业 4", "approved", { title: "完成 ECE 555 作业 4", dueDate: "2026-11-24" });
  order("wo-hw3", "完成 ECE 555 作业 3", "accepted", { title: "完成 ECE 555 作业 3" });
  order("wo-gone", "旧任务", "archived");
  store.setSetting(workspaceId, FIXED_EVENTS, JSON.stringify([{ id: "fixed-group", title: "组会", lineId: "research", date: "2026-11-03", start: "14:00", end: "15:00",
    location: "", source: "input", repeat: { weekdays: [2], from: "2026-11-03", until: "2026-12-31", exceptions: ["2026-11-24"] } }]));
  store.setSetting(workspaceId, MAIL_EVENTS_SETTING, JSON.stringify([
    { id: "e1", title: "Seminar", date: "2026-11-12", start: "16:00", end: "17:00", location: "", lineId: "", relevance: 50, personal: false, from: "", subject: "", state: "asked", at: "" },
    { id: "e2", title: "Mixer", date: "2026-11-13", start: "16:00", end: "17:00", location: "", lineId: "", relevance: 5, personal: false, from: "", subject: "", state: "skip", at: "" }]));
  const brief = buildLedgerBrief(store, workspaceId, NOW);
  expect(brief.milestones).toEqual([{ id: "m-ctrl", title: "控制方向资格考", line: "research", due: "", done: "" }]);
  expect(brief.openTasks).toEqual([{ id: "wo-hw4", title: "完成 ECE 555 作业 4", line: "research", milestoneId: "m-ctrl", due: "2026-11-24", state: "approved" }]);
  expect(brief.doneTasks).toEqual([{ id: "wo-hw3", title: "完成 ECE 555 作业 3" }]);
  // Tuesdays within 21 days of Nov 10, without the exception; the skipped mail event is left out.
  expect(brief.time.map((item) => [item.id, item.source])).toEqual([["fixed-group@2026-11-10", "fixed"], ["mail-e1", "mail"], ["fixed-group@2026-11-17", "fixed"]]);
  expect(briefIds(brief).known.has("fixed-group@2026-11-17")).toBe(true);
  // Byte-stable: the same ledger gives the same brief.
  expect(JSON.stringify(buildLedgerBrief(store, workspaceId, NOW))).toBe(JSON.stringify(brief));
});

test("past the caps the brief says how many more there are instead of dropping them silently", () => {
  const { store, workspaceId, order } = setup();
  for (let index = 0; index < 85; index += 1) order(`wo-${String(index).padStart(3, "0")}`, `任务 ${index}`);
  const brief = buildLedgerBrief(store, workspaceId, NOW);
  expect(brief.openTasks).toHaveLength(80);
  expect(brief.more.openTasks).toBe(5);
});
