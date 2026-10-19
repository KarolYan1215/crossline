import { expect, test } from "vitest";
import { AUTOMATION_RUNS_SETTING, AUTOMATIONS_SETTING, readAutomations, validateAutomationPlan, type Automation, type AutomationPlan } from "@crossline/core";
import { CrosslineStore, readCategories, requestAutomation } from "@crossline/db";
import type { AgentTaskInput } from "./agent-task";
import { AUTOMATION_DESIGNER_SKILL, automationPass, designPending, fire, onNewMail, type AutomationDeps } from "./automations";
import { fakeRuntime } from "./testing/fake-runtime";

const plan = (over: Partial<AutomationPlan> = {}, trigger: Partial<AutomationPlan["trigger"]> = {}): AutomationPlan => ({
  name: "课程邮件整理", summary: "每天早上把课程邮件整理成清单", lineId: "research",
  trigger: { type: "schedule", time: "08:00", days: "DAILY", hours: 0, from: "", keywords: "", url: "", event: "", ...trigger },
  action: { kind: "run", instructions: "读最近一天和课程有关的邮件，整理成待办清单写进 digest.md，把要做的事放进收件箱", reminder: "", category: "read_research_organize", outputs: "digest.md" },
  steps: [{ title: "读邮件并整理", by: "assistant" }, { title: "回复老师的邮件", by: "assistant" }], assumptions: "", replaces: "", enabled: true, ...over
});

function setup(now = new Date("2026-10-19T14:00:00Z")) {
  const store = new CrosslineStore(":memory:");
  const workspaceId = store.createPrincipalWithWorkspace("user-1", "w").workspace.id;
  store.setSetting(workspaceId, "lines.custom", JSON.stringify([{ id: "research", label: "研究者" }]));
  const started: Array<AgentTaskInput & { taskId: string }> = [];
  let busy = false;
  const deps = (client: AutomationDeps["client"] = () => undefined, fetched: string[] = []): AutomationDeps => ({
    store, cwd: "/repo", client, zone: () => "America/Chicago", now: () => now,
    runFree: (_w, input) => { if (busy) return { state: "blocked", code: "AGENT_BUSY", message: "助手正在做别的事。" }; started.push(input); return { state: "started", taskId: input.taskId }; },
    fetch: { isPublicHost: async () => true,
      fetchImpl: (async () => new Response(fetched.shift() ?? "<html><title>x</title><body>same</body></html>", { status: 200, headers: { "content-type": "text/html" } })) as typeof fetch }
  });
  return { store, workspaceId, started, deps, setBusy: (value: boolean) => { busy = value; }, setNow: (value: Date) => { now = value; } };
}
const install = (store: CrosslineStore, workspaceId: string, automation: Partial<Automation>) => {
  const base: Automation = { id: "auto-test1", name: "测试", summary: "", lineId: "research", status: "active", runs: 0,
    trigger: { type: "interval", hours: 4 }, action: { kind: "run", instructions: "整理新文件并写一份索引", category: "read_research_organize", outputs: [] },
    steps: [{ title: "整理", by: "assistant" }], origin: { kind: "asked", text: "x", requestId: "r" }, createdAt: "2026-10-19T00:00:00.000Z", updatedAt: "2026-10-19T00:00:00.000Z" };
  store.setSetting(workspaceId, AUTOMATIONS_SETTING, JSON.stringify([...readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING)), { ...base, ...automation }]));
};

test("a plan is checked: a step that sends is the person's, a watch needs a public https page, the schedule is read from words", () => {
  const checked = validateAutomationPlan(plan(), ["research"]);
  expect(checked.trigger).toEqual({ type: "schedule", schedule: { type: "daily", time: "08:00" } });
  // Replying leaves Crossline: it is the person's, whatever the plan said.
  expect(checked.steps[1]).toEqual({ title: "回复老师的邮件", by: "person" });
  expect(validateAutomationPlan(plan({ steps: [{ title: "把清单发送给导师", by: "assistant" }] }), ["research"]).steps[0]!.by).toBe("person");
  expect(validateAutomationPlan(plan({}, { days: "MO,FR" }), ["research"]).trigger).toEqual({ type: "schedule", schedule: { type: "weekly", days: ["MO", "FR"], time: "08:00" } });
  // Reading and sorting mail is the assistant's own work; the acts done to mail are the person's (the noun 邮件 alone used to count as one).
  const by = (title: string) => validateAutomationPlan(plan({ steps: [{ title, by: "assistant" }] }), ["research"]).steps[0]!.by;
  for (const title of ["读新邮件，摘出截止日期", "邮件里的截止日期写进收件箱", "起草回复存进草稿文件", "按发信人归类", "到点提醒本人"]) expect([title, by(title)]).toEqual([title, "assistant"]);
  for (const title of ["读邮件并回复", "给王老师发邮件确认时间", "删除垃圾邮件", "起草回复并发出", "发布到小红书"]) expect([title, by(title)]).toEqual([title, "person"]);
  expect(() => validateAutomationPlan(plan({}, { type: "watch", url: "http://127.0.0.1/admin" }), ["research"])).toThrow(/AUTOMATION_PLAN_INVALID/);
  expect(() => validateAutomationPlan(plan({ lineId: "nope" }), ["research"])).toThrow(/AUTOMATION_PLAN_INVALID/);
});

test("a request in words becomes an active automation, its kind of work is allowed by the request, and the person is told how it was read", async () => {
  const { store, workspaceId, deps } = setup();
  requestAutomation(store, workspaceId, "每天早上八点把邮箱里和课程有关的整理成清单", "research", "user-1");
  const { rpc } = fakeRuntime([JSON.stringify(plan({ assumptions: "按每天 08:00 理解" }))], AUTOMATION_DESIGNER_SKILL);
  const designed = await designPending(deps(() => rpc), workspaceId);
  expect(designed[0]).toMatchObject({ state: "created" });
  const [automation] = readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING));
  expect(automation).toMatchObject({ status: "active", name: "课程邮件整理", origin: { kind: "asked" } });
  expect(readCategories(store, workspaceId).read_research_organize).toBeTruthy();
  // Designed once: a second pass finds nothing waiting.
  expect(await designPending(deps(() => rpc), workspaceId)).toEqual([]);
  // Told what to change, it grows in place: same id, its runs kept, a new trigger.
  requestAutomation(store, workspaceId, "把课程邮件整理改成每天早晚各一次", "research", "user-1");
  const { rpc: second, prompts } = fakeRuntime([JSON.stringify(plan({ replaces: automation!.id }, { time: "20:00" }))], AUTOMATION_DESIGNER_SKILL);
  await designPending(deps(() => second), workspaceId);
  // The designer is shown the one it changes whole, in its own answer's shape, so the parts the request leaves alone can be copied back.
  const shown = JSON.parse(prompts()[0]!.slice(prompts()[0]!.indexOf("{"))) as { existing: Array<Record<string, unknown>> };
  expect(shown.existing[0]).toMatchObject({ id: automation!.id, lineId: "research", trigger: { type: "schedule", time: "08:00", days: "DAILY" },
    action: { kind: "run", category: "read_research_organize", outputs: "digest.md" } });
  const after = readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING));
  expect(after).toHaveLength(1);
  expect(after[0]).toMatchObject({ id: automation!.id, trigger: { type: "schedule", schedule: { time: "20:00" } } });
  expect(() => validateAutomationPlan(plan({ replaces: "auto-nope" }), ["research"], [automation!.id])).toThrow(/AUTOMATION_PLAN_INVALID/);
  // 「先停掉它」: the same automation, kept and paused.
  requestAutomation(store, workspaceId, "先停掉课程邮件整理", "research", "user-1");
  const { rpc: third } = fakeRuntime([JSON.stringify(plan({ replaces: automation!.id, enabled: false }))], AUTOMATION_DESIGNER_SKILL);
  await designPending(deps(() => third), workspaceId);
  expect(readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING))[0]).toMatchObject({ id: automation!.id, status: "off" });
});

test("a schedule fires once at its time; an interval after its hours; a busy assistant queues the firing for the next tick", async () => {
  const { store, workspaceId, deps, started, setBusy, setNow } = setup(new Date("2026-10-19T13:05:00Z"));
  install(store, workspaceId, { id: "auto-sched", trigger: { type: "schedule", schedule: { type: "daily", time: "08:00" } } });
  expect((await automationPass(deps(), workspaceId)).map((run) => run.state)).toEqual(["started"]);
  expect(started[0]!.title).toBe("自动化「测试」");
  expect(started[0]!.what).toContain("到了设定时间");
  expect(await automationPass(deps(), workspaceId)).toEqual([]);
  install(store, workspaceId, { id: "auto-every", trigger: { type: "interval", hours: 4 }, createdAt: "2026-10-19T08:00:00.000Z" });
  setBusy(true);
  setNow(new Date("2026-10-19T13:30:00Z"));
  expect((await automationPass(deps(), workspaceId)).map((run) => run.state)).toEqual(["queued"]);
  setBusy(false);
  // Only the queued firing goes; the interval does not fire twice for one due time.
  const next = await automationPass(deps(), workspaceId);
  expect(next.map((run) => `${run.automationId}:${run.state}`)).toEqual(["auto-every:started"]);
});

test("new mail matching a filter fires the automation with the messages as input; other mail does not", async () => {
  const { store, workspaceId, deps, started } = setup();
  install(store, workspaceId, { id: "auto-mail", trigger: { type: "mail", from: "uni.edu", keywords: ["HW"] } });
  const mail = (uid: number, subject: string, from = "Prof Lin <lin@uni.edu>") => ({ uid, subject, from, fromAddress: "", to: "", date: "2026-10-19T08:00:00.000Z", snippet: "", accountId: "a1" });
  expect(onNewMail(store, workspaceId, [mail(1, "Lunch?", "friend@x.com"), mail(2, "Seminar")])).toBe(0);
  expect(onNewMail(store, workspaceId, [mail(3, "HW2 posted"), mail(4, "Lunch?", "friend@x.com")])).toBe(1);
  await automationPass(deps(), workspaceId);
  expect(started[0]!.what).toContain("id a1:3");
  expect(started[0]!.what).not.toContain("Lunch");
});

test("a watched page: the first read is the baseline, a change fires with the new lines, and nothing fires while it stays the same", async () => {
  const { store, workspaceId, deps, started, setNow } = setup(new Date("2026-10-19T08:00:00Z"));
  install(store, workspaceId, { id: "auto-watch", trigger: { type: "watch", url: "https://course.example.edu/ece555", hours: 6 } });
  const same = "<html><body>HW1 due Oct 28</body></html>";
  await automationPass(deps(undefined, [same]), workspaceId);
  expect(started).toHaveLength(0);
  setNow(new Date("2026-10-19T15:00:00Z"));
  await automationPass(deps(undefined, [same]), workspaceId);
  expect(started).toHaveLength(0);
  setNow(new Date("2026-10-19T22:00:00Z"));
  await automationPass(deps(undefined, ["<html><body>HW1 due Oct 28\nHW2 due Nov 11</body></html>"]), workspaceId);
  expect(started).toHaveLength(1);
  expect(started[0]!.what).toContain("HW2 due Nov 11");
});

test("an automation runs as often as it fires (no daily count), and a reminder is said without starting the assistant", () => {
  const { store, workspaceId, deps, started } = setup();
  install(store, workspaceId, { id: "auto-cap" });
  const automation = readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING))[0]!;
  for (let i = 0; i < 8; i += 1) expect(fire(deps(), workspaceId, automation, { reason: "test", context: "" }).state).toBe("started");
  expect(started).toHaveLength(8);
  install(store, workspaceId, { id: "auto-remind", action: { kind: "remind", text: "交周报" } });
  const remind = readAutomations(store.getSetting(workspaceId, AUTOMATIONS_SETTING)).find((item) => item.id === "auto-remind")!;
  expect(fire(deps(), workspaceId, remind, { reason: "到点", context: "" }).state).toBe("reminded");
  expect(started).toHaveLength(8);
  expect(JSON.parse(store.getSetting(workspaceId, AUTOMATION_RUNS_SETTING)!).at(-1)).toMatchObject({ automationId: "auto-remind", state: "reminded" });
});

test("waiting for a busy assistant uses none of the day's runs, and a watched page's change waits in the queue instead of being lost", async () => {
  const { store, workspaceId, deps, started, setBusy, setNow } = setup(new Date("2026-10-19T08:00:00Z"));
  install(store, workspaceId, { id: "auto-watch", trigger: { type: "watch", url: "https://course.example.edu/x", hours: 1 } });
  await automationPass(deps(undefined, ["<html><body>a</body></html>"]), workspaceId);
  setBusy(true);
  setNow(new Date("2026-10-19T09:30:00Z"));
  expect((await automationPass(deps(undefined, ["<html><body>a\nb</body></html>"]), workspaceId)).map((run) => run.state)).toEqual(["queued"]);
  for (let hour = 10; hour < 18; hour += 1) { setNow(new Date(`2026-10-19T${hour}:30:00Z`)); await automationPass(deps(undefined, ["<html><body>a\nb</body></html>"]), workspaceId); }
  setBusy(false);
  await automationPass(deps(undefined, ["<html><body>a\nb</body></html>"]), workspaceId);
  expect(started).toHaveLength(1);
  expect(started[0]!.what).toContain("- b");
  // The waiting was noted once, not once a tick.
  expect(JSON.parse(store.getSetting(workspaceId, AUTOMATION_RUNS_SETTING)!).filter((run: { state: string }) => run.state === "queued")).toHaveLength(1);
});

test("a design that never keeps to the schema is said to the person at once; a passing trouble waits, three times at most", async () => {
  const { store, workspaceId, deps } = setup();
  requestAutomation(store, workspaceId, "每天提醒我喝水", "research", "user-1");
  const { rpc } = fakeRuntime(["not json", "still not", "nope"], AUTOMATION_DESIGNER_SKILL);
  expect((await designPending(deps(() => rpc), workspaceId))[0]).toMatchObject({ state: "failed" });
  expect(await designPending(deps(() => rpc), workspaceId)).toEqual([]);
});
