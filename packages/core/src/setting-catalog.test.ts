import { expect, test } from "vitest";
import { SETTING_CATALOG, SETTING_KEYS, actionProblem, isImmediate, parseShares, parseSlot, redactSecrets, settingProblem, type ConciergeRefs, type ProposedAction } from "./index";

const targets = { milestones: new Set(["m1"]), tasks: new Set(["wo-1"]), automations: new Set(["auto-1"]), mailboxes: new Set(["mail-1"]),
  blocks: new Set(["scheduled:wo-1"]), lines: new Set(["research", "startup"]) };
const change = (key: string, value: string, target = "") => settingProblem({ key, target, value }, targets);

test("a setting change is checked against the catalog: its key, the object it is about and the value's type", () => {
  expect(change("notify.level", "less")).toBe("");
  expect(change("notify.level", "loud")).toContain("off / less / normal / more");
  expect(change("schedule.gapMinutes", "10")).toBe("");
  expect(change("schedule.gapMinutes", "45")).toContain("0–30");
  expect(change("milestone.deadline", "2026-11-20", "m1")).toBe("");
  expect(change("milestone.deadline", "2026-11-20", "m9")).toContain("不是现有的");
  expect(change("notify.level", "less", "m1")).toContain("target 留空");
  expect(change("background.paused", "paused", "planning")).toBe("");
  expect(change("background.paused", "paused", "nope")).toContain("后台任务种类");
  expect(change("agent.category", "on", "draft_text")).toBe("");
  expect(change("mail.triage", "off", "mail-1")).toBe("");
  expect(change("schedule.lineShares", "research=60,startup=30")).toBe("");
  expect(change("schedule.lineShares", "research=80,startup=30")).toContain("100");
  expect(change("schedule.lineShares", "media=10")).toContain("不是主线");
  expect(change("block.move", "2026-11-02 14:00-15:00", "scheduled:wo-1")).toBe("");
  expect(change("block.move", "2026-11-02 15:00-14:00", "scheduled:wo-1")).not.toBe("");
  expect(change("consent.recordings", "off_delete")).toBe("");
});

test("credentials and destructive changes are never settings: the refusal sends the model to settings.open", () => {
  for (const key of ["mail.password", "model.apiKey", "health.token", "account.delete", "node.pairing"]) {
    expect(change(key, "x")).toContain("settings.open");
  }
  expect(SETTING_KEYS.some((key) => /(^|\.)(password|api.?key|token|delete|reset|pairing)/i.test(key))).toBe(false);
  expect(change("no.such.key", "1")).toContain("list_settings");
});

test("every consent carries the settings card's own explanation and can be turned both ways", () => {
  for (const key of SETTING_KEYS.filter((item) => item.startsWith("consent."))) {
    const entry = SETTING_CATALOG[key] as { consent?: true; explain?: readonly string[]; value: { type: string; values?: Record<string, string> } };
    expect(entry.consent).toBe(true);
    expect(entry.explain?.length).toBeGreaterThan(0);
    const values = Object.keys(entry.value.values ?? {});
    expect(values.some((value) => value === "on" || value === "minutes" || value === "detail")).toBe(true);
    expect(values.some((value) => value.startsWith("off"))).toBe(true);
  }
});

test("shares and slots are read from text", () => {
  expect(parseShares("research=60, startup=30")).toEqual({ research: 60, startup: 30 });
  expect(parseShares("research:60")).toBeUndefined();
  expect(parseSlot("2026-11-02 09:00-10:30")).toEqual({ day: "2026-11-02", start: "09:00", end: "10:30" });
});

test("reports of what happened run at once; settings and plan changes wait for the person", () => {
  const op = (type: string): ProposedAction => ({ action: "task.op", summary: "", args: { workOrderId: "wo-1", type, date: "", minutes: 40, stepId: "", text: "x", who: "", energy: "", outcome: "" } } as ProposedAction);
  expect(isImmediate(op("progress"))).toBe(true);
  expect(isImmediate(op("complete"))).toBe(true);
  expect(isImmediate(op("due"))).toBe(false);
  expect(isImmediate({ action: "sleep.report", summary: "", args: { wakeDate: "2026-10-30", sleepTime: "01:00", wakeTime: "08:00" } })).toBe(true);
  expect(isImmediate({ action: "setting.change", summary: "", args: { key: "notify.level", target: "", value: "less" } })).toBe(false);
});

test("a night is checked: a bedtime after the waking clock time was the evening before, and an implausible length is sent back", () => {
  const refs = { tasks: new Map(), asks: new Map(), ops: new Set(), lines: new Set(), milestones: new Set(), draftMilestones: new Set(), proposals: new Set(),
    agentResults: new Set(), today: "2026-10-30" } as ConciergeRefs;
  const night = (sleepTime: string, wakeTime: string, wakeDate = "2026-10-30"): ProposedAction => ({ action: "sleep.report", summary: "", args: { wakeDate, sleepTime, wakeTime } });
  expect(actionProblem(night("23:30", "07:30"), refs)).toBe("");
  expect(actionProblem(night("08:00", "08:10"), refs)).toContain("0.5–16");
  expect(actionProblem(night("23:30", "07:30", "2026-10-31"), refs)).toContain("之后");
});

test("a key pasted into the box is cut out; ordinary words about passwords are left alone", () => {
  expect(redactSecrets("我的 key 是 sk-abcdefghijklmnopqrstuv 帮我设置").text).not.toContain("sk-abc");
  expect(redactSecrets("邮箱密码是 hunter2pass").text).not.toContain("hunter2pass");
  expect(redactSecrets("我想改一下密码").redacted).toBe(false);
  expect(redactSecrets("token 用完了怎么办").redacted).toBe(false);
});
