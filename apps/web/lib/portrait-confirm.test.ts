import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { MAIL_ACCOUNTS_SETTING } from "@crossline/core";
vi.mock("server-only", () => ({}));
vi.mock("./codex-runtime", () => ({ requestCodexSupervisor: vi.fn(async () => ({})), CodexSupervisorRequestError: class extends Error {} }));
import { requestCodexSupervisor } from "./codex-runtime";
import { answerPortrait, appearanceOf, portraitConfirmation, setAppearance } from "./portrait";
import { connectionStatus } from "./settings-status";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; vi.clearAllMocks(); });
const ws = TEST_CTX.workspaceId;

function setup(portrait = "做事先定航线，再把能交出去的交出去。") {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  store.setSetting(ws, "profile.model", JSON.stringify({ portrait, coreConflict: "整块时间被切碎" }));
  return store;
}

// Whether the portrait fits is answered on the portrait page since 2026-10-28 (scenarios.md §3-10): 「符合」 must be the same record the
// interview's question wrote, or the interview's checklist would never be done.
test("「符合」 on the portrait page confirms the portrait as it stands, as the interview did", async () => {
  setup();
  expect(portraitConfirmation(TEST_CTX)).toMatchObject({ written: true, confirmed: false });
  expect(await answerPortrait(TEST_CTX, "yes", "")).toMatchObject({ ok: true });
  expect(portraitConfirmation(TEST_CTX).confirmed).toBe(true);
  // A rewritten portrait needs confirming again.
  globalThis.crosslineStore!.setSetting(ws, "profile.model", JSON.stringify({ portrait: "完全不同的另一段画像。", coreConflict: "别的矛盾" }));
  expect(portraitConfirmation(TEST_CTX).confirmed).toBe(false);
});

test("「大体符合」 needs a sentence and goes to the interview in its own question's words; nothing is confirmed", async () => {
  const store = setup();
  expect(await answerPortrait(TEST_CTX, "mostly", " ")).toMatchObject({ ok: false, code: "PORTRAIT_NOTE_REQUIRED" });
  store.saveOnboardingSession({ id: "s1", ownerId: TEST_CTX.principalId, workspaceId: ws, codexThreadId: "", state: "active", coverage: {},
    createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:00:00Z" });
  expect(await answerPortrait(TEST_CTX, "mostly", "第二句写得太绝对")).toMatchObject({ ok: true });
  expect(portraitConfirmation(TEST_CTX).confirmed).toBe(false);
  const body = JSON.parse(String((vi.mocked(requestCodexSupervisor).mock.calls[0]![2] as { body: string }).body)) as { sessionId: string; text: string };
  expect(body.sessionId).toBe("s1");
  expect(body.text).toContain("【「当前画像」写的是否符合本人？】");
  expect(body.text).toContain("第二句写得太绝对");
  expect(store.listEvents(ws, { type: "profile.portrait_feedback" })).toHaveLength(1);
});

test("nothing to confirm before the interview wrote a portrait", async () => {
  setup("");
  expect(await answerPortrait(TEST_CTX, "yes", "")).toMatchObject({ ok: false, code: "PORTRAIT_NOT_WRITTEN" });
});

test("the appearance written on the figure card is the confirmed fact the figure is drawn from", () => {
  setup();
  expect(setAppearance(TEST_CTX, {})).toMatchObject({ ok: false });
  expect(setAppearance(TEST_CTX, { text: "女，短发，常穿深绿外套" })).toEqual({ ok: true });
  expect(appearanceOf(TEST_CTX)).toEqual({ text: "女，短发，常穿深绿外套", skipped: false });
  const fact = globalThis.crosslineStore!.listProfileFacts(ws).find((item) => item.slot === "appearance")!;
  expect(fact).toMatchObject({ identityId: "person", status: "confirmed", sourceRef: "portrait-page" });
});

test("the settings status overview: a mailbox that failed is a row to fix, no mailbox is a row to connect", () => {
  const store = setup();
  const quota = { available: false, reason: "worker unreachable" } as const;
  const none = connectionStatus(TEST_CTX, quota, { machine: false, phoneUrl: false });
  expect(none.find((row) => row.kind === "mail")).toMatchObject({ state: "off", action: { href: "#mail" } });
  expect(none.find((row) => row.kind === "model")).toMatchObject({ state: "warn", action: { href: "#model" } });
  store.setSetting(ws, MAIL_ACCOUNTS_SETTING, JSON.stringify([{ id: "m1", address: "a@example.com", label: "", host: "imap.example.com", port: 993, triage: true,
    addedAt: "2026-10-01T00:00:00Z", lastCheckedAt: "2026-10-28T13:00:00Z", lastError: { code: "MAIL_AUTH_FAILED", message: "密码已失效", at: "2026-10-28T14:00:00Z" } }]));
  const rows = connectionStatus(TEST_CTX, quota, { machine: false, phoneUrl: false });
  expect(rows.find((row) => row.id === "mail:m1")).toMatchObject({ state: "warn", error: "密码已失效", action: { href: "#mail" } });
  expect(rows.find((row) => row.id === "mail:m1")?.lastOk).toBeTruthy();
});
