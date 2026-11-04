import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { AUTOMATION_RUNS_SETTING, AUTOMATIONS_SETTING, MAIL_ACCOUNTS_SETTING, MAIL_REPLIES_SETTING, type Automation, type MailAccount } from "@crossline/core";
import { CrosslineStore, requestAutomation } from "@crossline/db";
import { mailDraftsDir } from "./mail-replies";
import { automationsProbe, mailProbe } from "./self-check-mail";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const store = new CrosslineStore(":memory:");
  const workspaceId = store.createPrincipalWithWorkspace("user-1", "w").workspace.id;
  store.setSetting(workspaceId, "schedule.preferences", JSON.stringify({ timeZone: "America/Chicago" }));
  return { store, workspaceId };
}
const now = new Date("2026-10-19T15:00:00Z"); // 10:00 in Chicago
const account = (over: Partial<MailAccount> = {}): MailAccount => ({ id: "a1", address: "me@qq.com", label: "QQ 邮箱", host: "imap.qq.com", port: 993, triage: true,
  addedAt: "2026-10-01T00:00:00Z", lastCheckedAt: "2026-10-19T14:50:00Z", ...over });
const draft = (id: string, createdAt = "2026-10-19T14:00:00Z") => ({ id, accountId: "a1", uid: 1, uidValidity: "1", messageId: "", from: "x", fromAddress: "x@y.z", subject: "s",
  date: createdAt, why: "w", points: [], replyBy: "", file: `${id}.md`, createdAt });

test("mail: skipped with no mailbox; ok when read lately; a refusal, a stale read and a missing sent folder fail with a readable detail", async () => {
  const { store, workspaceId } = setup();
  const probe = mailProbe(store);
  expect((await probe.run(workspaceId, now)).status).toBe("skipped");
  store.setSetting(workspaceId, MAIL_ACCOUNTS_SETTING, JSON.stringify([account()]));
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "ok" });
  store.setSetting(workspaceId, MAIL_ACCOUNTS_SETTING, JSON.stringify([account({ lastError: { code: "MAIL_AUTH_FAILED", message: "邮箱拒绝了登录", at: "x" } })]));
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "failing", code: "MAIL_AUTH_FAILED", detail: expect.stringContaining("QQ 邮箱") });
  store.setSetting(workspaceId, MAIL_ACCOUNTS_SETTING, JSON.stringify([account({ lastCheckedAt: "2026-10-19T13:00:00Z" })]));
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "failing", code: "MAIL_CHECK_STALE", detail: expect.stringContaining("120") });
  store.setSetting(workspaceId, MAIL_ACCOUNTS_SETTING, JSON.stringify([account({ noSentFolder: "2026-10-19T14:00:00Z" })]));
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "failing", code: "MAIL_SENT_FOLDER_MISSING", detail: expect.stringContaining("已发送") });
});

test("mail: drafts whose file is gone and queued mail given up twice are dropped; drafts never told because notifications are off fail", async () => {
  const { store, workspaceId } = setup();
  const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-selfcheck-mail-"));
  dirs.push(dataDir);
  const dir = mailDraftsDir(dataDir, workspaceId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "rd-kept.md"), "x");
  store.setSetting(workspaceId, MAIL_ACCOUNTS_SETTING, JSON.stringify([account()]));
  store.setSetting(workspaceId, MAIL_REPLIES_SETTING, JSON.stringify([draft("rd-kept"), draft("rd-gone")]));
  store.setSetting(workspaceId, "mail.replyQueue", JSON.stringify([{ uid: 1, accountId: "a1", failures: 2 }, { uid: 2, accountId: "a1", failures: 1 }, { uid: 3, accountId: "a1" }]));
  const probe = mailProbe(store, dataDir);
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "repaired", code: "MAIL_DRAFT_FILE_MISSING" });
  expect(JSON.parse(store.getSetting(workspaceId, MAIL_REPLIES_SETTING)!).map((item: { id: string }) => item.id)).toEqual(["rd-kept"]);
  expect(JSON.parse(store.getSetting(workspaceId, "mail.replyQueue")!).map((item: { uid: number }) => item.uid)).toEqual([2, 3]);
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "ok" });
  // Written two days ago and never told: only a failure while notifications are off.
  writeFileSync(path.join(dir, "rd-old.md"), "x");
  store.setSetting(workspaceId, MAIL_REPLIES_SETTING, JSON.stringify([draft("rd-kept"), draft("rd-old", "2026-10-17T14:00:00Z")]));
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "ok" });
  store.setSetting(workspaceId, "notify.level", "off");
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "failing", code: "NOTIFY_OFF_DRAFTS_UNTOLD" });
});

const automation = (over: Partial<Automation>): Automation => ({ id: "auto-a", name: "早报", summary: "", lineId: "research", status: "active", runs: 0,
  trigger: { type: "schedule", schedule: { type: "daily", time: "08:00" } }, action: { kind: "run", instructions: "整理", category: "read_research_organize", outputs: [] },
  steps: [{ title: "整理", by: "assistant" }], origin: { kind: "asked", text: "x", requestId: "r" }, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z", ...over });

test("automations: a schedule passed today with no run fails; one that ran or was noted today, or is not yet late, is fine", async () => {
  const { store, workspaceId } = setup();
  const probe = automationsProbe(store);
  expect((await probe.run(workspaceId, now)).status).toBe("skipped");
  store.setSetting(workspaceId, AUTOMATIONS_SETTING, JSON.stringify([automation({})]));
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "failing", code: "AUTOMATION_SCHEDULE_MISSED", detail: expect.stringContaining("早报") });
  // 08:20 in Chicago: twenty minutes late is not missed yet.
  expect(await probe.run(workspaceId, new Date("2026-10-19T13:20:00Z"))).toMatchObject({ status: "ok" });
  store.setSetting(workspaceId, AUTOMATION_RUNS_SETTING, JSON.stringify([{ automationId: "auto-a", taskId: "", firedAt: "2026-10-19T13:01:00Z", reason: "", state: "queued" }]));
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "ok" });
  store.setSetting(workspaceId, AUTOMATION_RUNS_SETTING, "[]");
  store.setSetting(workspaceId, AUTOMATIONS_SETTING, JSON.stringify([automation({ lastFiredAt: "2026-10-19T13:00:00Z" })]));
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "ok" });
  // Made after today's time: not missed.
  store.setSetting(workspaceId, AUTOMATIONS_SETTING, JSON.stringify([automation({ createdAt: "2026-10-19T14:30:00Z", updatedAt: "2026-10-19T14:30:00Z" })]));
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "ok" });
});

test("automations: an old queued firing is dropped; a watch that fails or stopped reading and a design never taken up fail", async () => {
  const { store, workspaceId } = setup();
  const probe = automationsProbe(store);
  store.setSetting(workspaceId, AUTOMATIONS_SETTING, JSON.stringify([automation({ trigger: { type: "interval", hours: 4 } })]));
  store.setSetting(workspaceId, "automations.queue", JSON.stringify([{ automationId: "auto-a", at: "2026-10-19T12:00:00Z", reason: "", context: "" },
    { automationId: "auto-a", at: "2026-10-19T14:30:00Z", reason: "", context: "" }]));
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "repaired", code: "AUTOMATION_QUEUE_STALE" });
  expect(JSON.parse(store.getSetting(workspaceId, "automations.queue")!)).toHaveLength(1);
  const watch = (extra: Partial<NonNullable<Automation["watch"]>>) => automation({ trigger: { type: "watch", url: "https://course.example.edu/x", hours: 2 },
    watch: { hash: "h", excerpt: "", checkedAt: "2026-10-19T14:30:00Z", ...extra } });
  store.setSetting(workspaceId, AUTOMATIONS_SETTING, JSON.stringify([watch({})]));
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "ok" });
  store.setSetting(workspaceId, AUTOMATIONS_SETTING, JSON.stringify([watch({ lastError: "返回 503" })]));
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "failing", code: "AUTOMATION_WATCH_FAILING", detail: expect.stringContaining("返回 503") });
  store.setSetting(workspaceId, AUTOMATIONS_SETTING, JSON.stringify([watch({ checkedAt: "2026-10-19T09:00:00Z" })]));
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "failing", code: "AUTOMATION_WATCH_FAILING" });
  store.setSetting(workspaceId, AUTOMATIONS_SETTING, "[]");
  requestAutomation(store, workspaceId, "每周五归档新材料", "research", "user-1");
  expect(await probe.run(workspaceId, now)).toMatchObject({ status: "ok" });
  expect(await probe.run(workspaceId, new Date(Date.now() + 2 * 3_600_000))).toMatchObject({ status: "failing", code: "AUTOMATION_DESIGN_STUCK", detail: expect.stringContaining("每周五归档新材料") });
});
