import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { CALENDAR_IMIP_RECIPIENT_SETTING, CALENDAR_WRITE_PATHS_SETTING, MAIL_EVENTS_SETTING, type MailEvent } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({ state: "published" })), CodexSupervisorRequestError: class extends Error {} }));
import { answerAsk, collectAsks } from "./asks";
import { calendarItems, feedText, feedToken, imipPass, resetFeedToken, workspaceForFeedToken, type InviteMail } from "./calendar-write";
import { inputEvents } from "./fixed-events";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); });
const ws = TEST_CTX.workspaceId;
const NOW = new Date("2026-10-12T13:00:00.000Z");

/** A workspace with a confirmed weekly class and a timed exam, chosen for the calendar, and no Microsoft account at all. */
function setup(paths: Record<string, boolean> = { ics: true }) {
  vi.stubEnv("CROSSLINE_FIXED_NOW", NOW.toISOString());
  // No mail can leave a test: no SMTP, no mailbox directory.
  for (const key of ["CROSSLINE_SMTP_HOST", "CROSSLINE_SMTP_PORT", "CROSSLINE_SMTP_USER", "CROSSLINE_SMTP_PASSWORD", "CROSSLINE_SMTP_FROM", "CROSSLINE_AUTH_TEST_MAILBOX_DIR"]) vi.stubEnv(key, "");
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.saveProject({ id: "ece555", ownerId: "o", workspaceId: ws, identityId: "research", name: "ECE 555", summary: "", status: "active", createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" });
  store.savePlanVersion({ id: "plan-1", ownerId: "o", workspaceId: ws, version: 1, status: "draft", payload: { blocks: [] } });
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "dates:1", type: "dates.extracted", entityId: "b1", payload: { documentIds: [],
    recurring: [{ id: "class", title: "上课", project: "ECE 555", weekdays: [1, 5], startTime: "14:30", endTime: "15:45", from: "2026-09-04", to: "2026-12-07", exceptions: ["2026-11-27"], location: "Plant Sci 108", sourceRef: "src-2" }],
    dates: [{ id: "exam", title: "期中考试", project: "ECE 555", date: "2026-10-27", startTime: "14:30", endTime: "15:45", kind: "exam", sourceRef: "src-1" }], undated: [] } });
  store.appendEvent({ ownerId: "o", workspaceId: ws, idempotencyKey: "dates:2", type: "dates.decided", entityId: "b1", payload: { included: ["class", "exam"], excluded: [] } });
  store.setSetting(ws, "portrait.report", JSON.stringify({ version: 1 }));
  store.setSetting(ws, CALENDAR_WRITE_PATHS_SETTING, JSON.stringify(paths));
  return store;
}

test("any path on is enough for 「创建」 to be offered; with every path off nothing is", async () => {
  setup({ ics: true });
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "event_propose")).toHaveLength(2);
  setup({});
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "event_propose")).toEqual([]);
});

test("the feed carries only chosen fixed events and work blocks, titled 「主线 · 任务名」, with stable UIDs and no notes or places", async () => {
  setup();
  await answerAsk(TEST_CTX, "event:batch:b1:class", "create", {}, NOW);
  await answerAsk(TEST_CTX, "event:batch:b1:exam", "create", {}, NOW);
  const text = await feedText(TEST_CTX, NOW);
  const unfolded = text.replace(/\r\n[ \t]/g, "");
  const values = (name: string) => [...unfolded.matchAll(new RegExp(`^${name}[^:]*:(.*)$`, "gm"))].map((match) => match[1]!.trim()).sort();
  expect(text.split("\r\n").every((line) => Buffer.byteLength(line) <= 75)).toBe(true);
  expect(values("SUMMARY")).toEqual(["研究者 · ECE 555 上课", "研究者 · ECE 555 期中考试"]);
  expect(values("UID")).toEqual(["fixed:batch:b1:class@crossline.lol", "fixed:batch:b1:exam@crossline.lol"]);
  expect(values("RRULE")[0]).toContain("FREQ=WEEKLY;BYDAY=MO,FR");
  expect(text).not.toMatch(/LOCATION|DESCRIPTION:(?!研究者)/);
  expect(text).not.toContain("Plant Sci");
  // The same request twice gives the same UIDs.
  expect((await feedText(TEST_CTX, NOW)).match(/UID:[^\r]+/g)).toEqual(text.match(/UID:[^\r]+/g));
});

test("the feed token opens only its own workspace, only while the feed is on, and a new token kills the old link", async () => {
  const store = setup();
  // The test workspace has no principal row; the lookup walks workspaces, so it is listed here.
  vi.spyOn(store, "listWorkspaces").mockReturnValue([{ id: ws } as ReturnType<typeof store.listWorkspaces>[number]]);
  const token = feedToken(TEST_CTX);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(workspaceForFeedToken(token)).toBe(ws);
  expect(workspaceForFeedToken(`${token.slice(0, -1)}x`)).toBeUndefined();
  const fresh = resetFeedToken(TEST_CTX);
  expect(workspaceForFeedToken(token)).toBeUndefined();
  expect(workspaceForFeedToken(fresh)).toBe(ws);
  store.setSetting(ws, CALENDAR_WRITE_PATHS_SETTING, JSON.stringify({ ics: false }));
  expect(workspaceForFeedToken(fresh)).toBeUndefined();
});

test("invitations: REQUEST once per change with SEQUENCE bumped, nothing for unchanged ones, CANCEL only for one still to come", async () => {
  const store = setup({ imip: true });
  store.setSetting(ws, CALENDAR_IMIP_RECIPIENT_SETTING, "person@example.com");
  await answerAsk(TEST_CTX, "event:batch:b1:class", "create", {}, NOW);
  await answerAsk(TEST_CTX, "event:batch:b1:exam", "create", {}, NOW);
  const mails: InviteMail[] = [];
  const send = async (mail: InviteMail) => { mails.push(mail); };
  const { items } = await calendarItems(TEST_CTX, NOW);
  expect(await imipPass(TEST_CTX, items, send, NOW)).toEqual({ sent: 2, cancelled: 0, left: 0 });
  expect(mails.every((mail) => mail.to === "person@example.com" && mail.method === "REQUEST" && mail.ics.includes("METHOD:REQUEST\r\n") && mail.ics.includes("SEQUENCE:0\r\n"))).toBe(true);
  expect(mails[0]!.ics).toContain("ORGANIZER;CN=Crossline:mailto:calendar@mail.crossline.lol");
  // Nothing changed: nothing is mailed. A week later the series' next occurrence moved, which is not a change either.
  expect(await imipPass(TEST_CTX, items, send, NOW)).toEqual({ sent: 0, cancelled: 0, left: 0 });
  const later = new Date("2026-10-19T13:00:00.000Z");
  vi.stubEnv("CROSSLINE_FIXED_NOW", later.toISOString());
  expect((await imipPass(TEST_CTX, (await calendarItems(TEST_CTX, later)).items, send, later)).sent).toBe(0);
  // The exam is removed from the calendar choice: one CANCEL with the next sequence.
  const withoutExam = (await calendarItems(TEST_CTX, later)).items.filter((item) => !item.id.includes("exam"));
  expect(await imipPass(TEST_CTX, withoutExam, send, later)).toEqual({ sent: 0, cancelled: 1, left: 0 });
  expect(mails.at(-1)).toMatchObject({ method: "CANCEL" });
  expect(mails.at(-1)!.ics).toContain("SEQUENCE:1\r\n");
  expect(mails.at(-1)!.ics).toContain("STATUS:CANCELLED\r\n");
  // Without an address nothing goes anywhere.
  store.deleteSetting(ws, CALENDAR_IMIP_RECIPIENT_SETTING);
  await expect(imipPass(TEST_CTX, items, send, NOW)).rejects.toThrow("CALENDAR_IMIP_NO_RECIPIENT");
});

test("invitations: a block re-planned past the mailed week is updated, not cancelled; one that comes back after a CANCEL gets a higher SEQUENCE", async () => {
  const store = setup({ imip: true });
  store.setSetting(ws, CALENDAR_IMIP_RECIPIENT_SETTING, "person@example.com");
  const mails: InviteMail[] = [];
  const send = async (mail: InviteMail) => { mails.push(mail); };
  const block = (start: string, end: string) => ({ id: "scheduled:b1", uid: "scheduled-b1@crossline", title: "研究 · 写摘要", start, end, reminderMinutes: 10 });
  // Each step after the quiet window of the one before.
  const after = (hours: number) => new Date(NOW.getTime() + hours * 61 * 60_000);
  expect(await imipPass(TEST_CTX, [block("2026-10-14T15:00:00.000Z", "2026-10-14T16:00:00.000Z")], send, NOW)).toMatchObject({ sent: 1, cancelled: 0 });
  // Moved ten days out: still on the plan, so its invitation moves with it.
  expect(await imipPass(TEST_CTX, [block("2026-10-24T15:00:00.000Z", "2026-10-24T16:00:00.000Z")], send, after(1))).toMatchObject({ sent: 1, cancelled: 0 });
  expect(mails.at(-1)).toMatchObject({ method: "REQUEST" });
  expect(mails.at(-1)!.ics).toContain("SEQUENCE:1\r\n");
  // Off the plan: cancelled (sequence 2); back on it: a REQUEST above the CANCEL, so the calendar takes it.
  expect(await imipPass(TEST_CTX, [], send, after(2))).toMatchObject({ sent: 0, cancelled: 1 });
  expect(mails.at(-1)!.ics).toContain("SEQUENCE:2\r\n");
  expect(await imipPass(TEST_CTX, [], send, after(2))).toMatchObject({ sent: 0, cancelled: 0 });
  expect(await imipPass(TEST_CTX, [block("2026-10-14T15:00:00.000Z", "2026-10-14T16:00:00.000Z")], send, after(3))).toMatchObject({ sent: 1, cancelled: 0 });
  expect(mails.at(-1)).toMatchObject({ method: "REQUEST" });
  expect(mails.at(-1)!.ics).toContain("SEQUENCE:3\r\n");
});

test("invitations do not flood: nudges are not mailed, a block re-planned within the hour waits and goes once, and each pass and day is capped", async () => {
  const store = setup({ imip: true });
  store.setSetting(ws, CALENDAR_IMIP_RECIPIENT_SETTING, "person@example.com");
  const mails: InviteMail[] = [];
  const send = async (mail: InviteMail) => { mails.push(mail); };
  const minutes = (count: number) => new Date(NOW.getTime() + count * 60_000);
  const block = (id: string, start: string, end: string) => ({ id: `scheduled:${id}`, uid: `scheduled-${id}@crossline`, title: `研究 · ${id}`, start, end, reminderMinutes: 10 });
  expect(await imipPass(TEST_CTX, [block("a", "2026-10-14T15:00:00.000Z", "2026-10-14T16:00:00.000Z")], send, NOW)).toMatchObject({ sent: 1 });
  // A re-plan nudges it ten minutes: under the minimum shift, no mail.
  expect(await imipPass(TEST_CTX, [block("a", "2026-10-14T15:10:00.000Z", "2026-10-14T16:10:00.000Z")], send, minutes(10))).toMatchObject({ sent: 0, left: 0 });
  // Moved two hours, then again, inside the hour after the last mail: held back, then one mail with where it ended up.
  expect(await imipPass(TEST_CTX, [block("a", "2026-10-14T17:00:00.000Z", "2026-10-14T18:00:00.000Z")], send, minutes(20))).toMatchObject({ sent: 0, left: 1 });
  expect(await imipPass(TEST_CTX, [block("a", "2026-10-14T19:00:00.000Z", "2026-10-14T20:00:00.000Z")], send, minutes(40))).toMatchObject({ sent: 0, left: 1 });
  expect(await imipPass(TEST_CTX, [block("a", "2026-10-14T19:00:00.000Z", "2026-10-14T20:00:00.000Z")], send, minutes(61))).toMatchObject({ sent: 1, left: 0 });
  expect(mails).toHaveLength(2);
  expect(mails.at(-1)!.ics).toContain("SEQUENCE:1\r\n");
  // One that begins within the hour is not held back.
  expect(await imipPass(TEST_CTX, [block("soon", "2026-10-12T15:30:00.000Z", "2026-10-12T16:00:00.000Z")], send, minutes(61))).toMatchObject({ sent: 1 });
  expect(await imipPass(TEST_CTX, [block("soon", "2026-10-12T14:30:00.000Z", "2026-10-12T15:00:00.000Z")], send, minutes(62))).toMatchObject({ sent: 1 });
  // Forty new blocks: five a pass, soonest first, and no more than the daily cap in 24 hours.
  const many = Array.from({ length: 40 }, (_, index) => block(`m${String(index).padStart(2, "0")}`, `2026-10-${String(13 + (index % 5)).padStart(2, "0")}T${String(8 + Math.floor(index / 5)).padStart(2, "0")}:00:00.000Z`,
    `2026-10-${String(13 + (index % 5)).padStart(2, "0")}T${String(8 + Math.floor(index / 5)).padStart(2, "0")}:30:00.000Z`))
    .concat([block("a", "2026-10-14T19:00:00.000Z", "2026-10-14T20:00:00.000Z"), block("soon", "2026-10-12T14:30:00.000Z", "2026-10-12T15:00:00.000Z")]);
  const before = mails.length;
  const first = await imipPass(TEST_CTX, many, send, minutes(70));
  expect(first).toMatchObject({ sent: 5, left: 35 });
  expect(mails.slice(before).map((mail) => mail.subject)).toEqual(["研究 · m00", "研究 · m05", "研究 · m10", "研究 · m15", "研究 · m20"]);
  for (let pass = 1; pass < 12; pass += 1) await imipPass(TEST_CTX, many, send, minutes(70 + pass * 10));
  expect(mails.length).toBe(30);
  expect(await imipPass(TEST_CTX, many, send, minutes(200))).toMatchObject({ sent: 0, left: 14 });
  // A day after the first mails, room again.
  expect((await imipPass(TEST_CTX, many, send, minutes(24 * 60 + 1))).sent).toBeGreaterThan(0);
});

test("mail events: personal first and recommended; 去 makes a fixed event every path writes, 不去 drops it", async () => {
  const store = setup({ ics: true });
  const event = (id: string, title: string, personal: boolean, relevance: number): MailEvent => ({ id, title, date: "2026-10-20", start: "14:00", end: "15:00", location: "",
    lineId: "", relevance, personal, from: "Prof Lin", subject: title, state: "asked", at: NOW.toISOString() });
  store.setSetting(ws, MAIL_EVENTS_SETTING, JSON.stringify([event("talk", "Robust control seminar", false, 80), event("meet", "与 Lin 老师见面", true, 30),
    { ...event("mixer", "Coffee hour", false, 10), state: "digest" }]));
  const asks = collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "mail_event");
  expect(asks.map((ask) => [ask.entityId, ask.options[0]!.recommended])).toEqual([["meet", true], ["talk", true]]);
  expect(asks[0]!.title).toBe("要去吗：「与 Lin 老师见面」");
  await answerAsk(TEST_CTX, "mail-event:meet", "go", {}, NOW);
  await answerAsk(TEST_CTX, "mail-event:talk", "skip", {}, NOW);
  expect(inputEvents(TEST_CTX).map((item) => [item.id, item.source])).toEqual([["mail-meet", "mail"]]);
  expect((await calendarItems(TEST_CTX, NOW)).items.map((item) => item.id)).toContain("fixed:mail-meet");
  expect(collectAsks(TEST_CTX, NOW).filter((ask) => ask.kind === "mail_event")).toEqual([]);
});
