import { expect, test } from "vitest";
import { FIXED_EVENTS } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { MAIL_INTAKE_REPAIR, mailIntakeRepair } from "./mail-intake-repair";
import { nearTermCaptures } from "./onboarding-extract";
import { MAIL_TRIAGE_SKILL } from "./mailbox";
import { meetingCandidates, meetingDuplicatePass, MEETING_JUDGED_SETTING } from "./meeting-dedupe";
import { fakeRuntime } from "./testing/fake-runtime";

const NOW = new Date("2026-11-10T09:00:00Z");

function setup() {
  const store = new CrosslineStore(":memory:");
  const { principal, workspace } = store.createPrincipalWithWorkspace("user-1", "w");
  const order = (id: string, title: string, payload: Record<string, unknown> = {}) => store.saveWorkOrder({ id, ownerId: principal.id, workspaceId: workspace.id,
    identityId: "research", projectId: "", milestoneId: "", intent: title, state: "approved", riskTier: "routine",
    estimate: { p25Minutes: 20, p50Minutes: 30, p85Minutes: 60, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: { title, ...payload } } as never);
  store.setSetting(workspace.id, FIXED_EVENTS, JSON.stringify([{ id: "fixed-group", title: "控制组组会", lineId: "research", date: "2026-11-03", start: "14:00", end: "15:00",
    location: "", source: "input", repeat: { weekdays: [2], from: "2026-11-03", until: "2026-12-31", exceptions: [] } }]));
  return { store, workspaceId: workspace.id, order };
}
const state = (store: CrosslineStore, workspaceId: string, id: string) => store.listWorkOrders(workspaceId).find((item) => item.id === id)?.state;

test("a task that is only going to a meeting already on the calendar is archived once the model calls them the same; the calendar item stays", async () => {
  const { store, workspaceId, order } = setup();
  order("wo-join", "参加控制组组会", { dueDate: "2026-11-17" });
  order("wo-slides", "准备控制组组会报告幻灯片", { dueDate: "2026-11-17" });
  order("wo-other", "整理采购发票");
  // Code circles candidates on cheap signals: the slides and the join task, one series each, not the invoices.
  const pairs = meetingCandidates(store, workspaceId, NOW);
  expect(pairs.map((pair) => [pair.taskId, pair.time.id.split("@")[0]])).toEqual(expect.arrayContaining([["wo-join", "fixed-group"], ["wo-slides", "fixed-group"]]));
  expect(pairs.some((pair) => pair.taskId === "wo-other")).toBe(false);
  const ids = pairs.map((pair) => pair.taskId);
  const answer = JSON.stringify({ pairs: ids.map((id, index) => ({ id: `p${index + 1}`, same: id === "wo-join", why: id === "wo-join" ? "只是去开会" : "要准备交付物" })) });
  const { rpc } = fakeRuntime([answer], "crossline:crossline-validation-reviewer");
  const done = await meetingDuplicatePass(store, workspaceId, rpc, "/repo", NOW);
  expect(done).toEqual([{ taskId: "wo-join", title: "参加控制组组会", calendar: "控制组组会" }]);
  expect(state(store, workspaceId, "wo-join")).toBe("archived");
  expect(state(store, workspaceId, "wo-slides")).toBe("approved");
  const op = store.listEvents(workspaceId, { type: "op.applied" }).at(-1)!;
  expect(op.payload).toMatchObject({ bySystem: true, inverse: { kind: "task.unmerge", restore: ["wo-join"] } });
  // Each pair is judged once.
  expect(Object.keys(JSON.parse(store.getSetting(workspaceId, MEETING_JUDGED_SETTING)!))).toHaveLength(ids.length);
  expect(meetingCandidates(store, workspaceId, NOW)).toEqual([]);
});

test("the one-time mail cleanup judges old mail tasks with the brief: events, unrelated and known ones are archived, course work stays, one undo for all", async () => {
  const { store, workspaceId, order } = setup();
  order("cap-mail-movie", "参加研究生电影之夜");
  order("cap-mail-health", "参加校园健康日");
  order("cap-mail-hw4", "完成 ECE 555 作业 4", { dueDate: "2026-11-24" });
  order("cap-mail-hw4b", "提交 HW4");
  order("wo-hw4", "完成 ECE 555 作业 4（本人建）", { dueDate: "2026-11-24" });
  order("cap-mail-group", "参加控制组组会");
  const answer = JSON.stringify({ items: [
    { id: "cap-mail-movie", verdict: "event", known: "", why: "社团活动" },
    { id: "cap-mail-health", verdict: "unrelated", known: "", why: "与里程碑无关" },
    { id: "cap-mail-hw4", verdict: "keep", known: "", why: "课程作业" },
    { id: "cap-mail-hw4b", verdict: "known", known: "cap-mail-hw4b", why: "同一份作业" },
    { id: "cap-mail-group", verdict: "known", known: "fixed-group@2026-11-17", why: "日历上已有" }] });
  // The first answer points a task at itself: sent back once, then answered properly.
  const fixed = answer.replace('"known": "cap-mail-hw4b"', '"known": "wo-hw4"').replace(/"known":"cap-mail-hw4b"/, '"known":"wo-hw4"');
  const { rpc, prompts } = fakeRuntime([answer, fixed], MAIL_TRIAGE_SKILL);
  const archived = await mailIntakeRepair(store, workspaceId, rpc, "/repo", NOW);
  expect(JSON.stringify(prompts())).toContain("known 必须是账本简报里另一项的 id");
  expect(archived.sort()).toEqual(["cap-mail-group", "cap-mail-health", "cap-mail-hw4b", "cap-mail-movie"]);
  expect(state(store, workspaceId, "cap-mail-hw4")).toBe("approved");
  const reasons = store.listEvents(workspaceId, { type: "work_order.archived" }).map((event) => (event.payload as { reason: string }).reason);
  expect(reasons).toEqual(expect.arrayContaining(["邮件里的活动，不作为任务", "与里程碑无关，未列入", "与「完成 ECE 555 作业 4（本人建）」是同一件", "与「控制组组会」是同一件"]));
  expect(store.listEvents(workspaceId, { type: "op.applied" }).at(-1)!.payload).toMatchObject({ inverse: { kind: "work_order.restore" } });
  // Once only.
  expect(store.getSetting(workspaceId, MAIL_INTAKE_REPAIR)).toBeTruthy();
  expect(await mailIntakeRepair(store, workspaceId, rpc, "/repo", NOW)).toEqual([]);
});

test("near-term work said in the interview becomes a capture at once, once per sentence; 「没有」 makes none", () => {
  const { store, workspaceId } = setup();
  const fact = (value: string, status: "confirmed" | "inferred" = "confirmed") => ({ identityId: "research", projectId: "", slot: "near_term", value, status, sourceRef: "reply-3", sourceQuote: value });
  const facts = [fact("11/24 前提交 ECE 555 HW4"), fact("没有"), fact("写开题报告", "inferred"), { ...fact("x"), slot: "goal" }];
  expect(nearTermCaptures(store, workspaceId, "user-1", "s1", facts)).toBe(1);
  expect(nearTermCaptures(store, workspaceId, "user-1", "s1", facts)).toBe(0);
  expect(store.listCaptures(workspaceId).map((capture) => capture.title)).toEqual(["11/24 前提交 ECE 555 HW4"]);
});
