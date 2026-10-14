import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { LEDGER_EVENT_TYPES, TELEMETRY_COUNT_FIELDS, TELEMETRY_FIELDS, TELEMETRY_TOKEN_FIELDS } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { TELEMETRY_CURSOR_SETTING, TELEMETRY_ENABLED_SETTING, telemetryPass } from "./telemetry";

/**
 * The promise: behaviour leaves the machine, content never does. This fills a real ledger with the kinds of things a person writes —
 * in every field the sender reads from — and checks the bytes that would be posted: none of the person's words, none of the raw ids,
 * no key outside the whitelist.
 */
const SECRETS = ["秘密任务标题", "dissertation-draft.pdf", "https://private.example/doc", "Dr. Example Person", "我的访谈回答", "Secret free text"];
const RAW_ID = "wo-7f3a-raw-entity-id";
const ENV = { CROSSLINE_TELEMETRY_URL: "https://collector.example", CROSSLINE_INSTALL_ID: "6b0c7f2e-2b7a-4c55-9c1e-8e5c2f0a4d11",
  CROSSLINE_TELEMETRY_SALT: "salt-salt-salt", CROSSLINE_APP_VERSION: "0.2.0" };

let store: CrosslineStore;
let dataDir: string;
let workspaceId: string;
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  dataDir = mkdtempSync(path.join(tmpdir(), "crossline-telemetry-"));
  workspaceId = store.createPrincipalWithWorkspace("auth-user", "个人 workspace").workspace.id;
});
afterEach(() => { store.close(); rmSync(dataDir, { recursive: true, force: true }); });

function seed(): void {
  const text = SECRETS.join(" ");
  // Every passed-on type, each carrying free text in the places a payload keeps it, plus a code and a state that are allowed.
  for (const [index, type] of LEDGER_EVENT_TYPES.entries()) store.appendEvent({ ownerId: "o", workspaceId, idempotencyKey: `k${index}`, type, entityId: RAW_ID,
    payload: { title: text, intent: text, message: text, reason: text, to: type === "work_order.transitioned" ? "active" : text, kind: text,
      code: type === "agent.task.blocked" ? "AGENT_RUN_LOST" : text, verdict: text, files: [{ name: SECRETS[1], url: SECRETS[2] }], nested: { deep: text } } });
  // Types that are not on the list are not sent at all, whatever they hold.
  store.appendEvent({ ownerId: "o", workspaceId, idempotencyKey: "note", type: "task.note", entityId: RAW_ID, payload: { text } });
  store.saveModelUsage({ workspaceId, skill: "crossline:crossline-onboarding", tier: "top", model: "gpt", effort: "medium", spendMode: "normal",
    threadId: SECRETS[5]!, ok: false, errorCode: "SKILL_STALLED", repairs: 2, turns: 3, inputTokens: 1200, cachedInputTokens: 300, outputTokens: 90,
    reasoningTokens: 10, totalTokens: 1600, durationMs: 4200, at: new Date().toISOString() });
  store.saveModelUsage({ workspaceId, skill: SECRETS[0]!, tier: "", model: "", effort: "", spendMode: "normal", threadId: "", ok: true,
    errorCode: SECRETS[5]!, repairs: 0, turns: 1, inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, totalTokens: 2, durationMs: 1, at: new Date().toISOString() });
  const now = new Date().toISOString();
  store.saveOnboardingSession({ id: "s1", ownerId: "o", workspaceId, state: "active", coverage: { note: text }, createdAt: now, updatedAt: now });
  store.appendOnboardingMessage({ sessionId: "s1", workspaceId, role: "assistant", content: { stage: "lines", message: text }, createdAt: now });
  store.appendOnboardingMessage({ sessionId: "s1", workspaceId, role: "user", content: { text }, createdAt: new Date(Date.now() + 1).toISOString() });
  // Page views as the web writes them, plus what a tampered outbox might hold.
  mkdirSync(path.join(dataDir, "telemetry"), { recursive: true });
  writeFileSync(path.join(dataDir, "telemetry", "pages.jsonl"), [
    { page: "/workbench/[id]", at: now }, { page: `/workbench/${RAW_ID}`, at: now }, { page: SECRETS[2], at: now }, { page: "/plan", at: now, title: text }
  ].map((line) => JSON.stringify(line)).join("\n"));
}

async function send(env: Record<string, string> = ENV) {
  const posted: string[] = [];
  const outcome = await telemetryPass({ store, workspaceId, dataDir, env, accountEmail: async () => "Tester@Example.com",
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => { posted.push(String(init?.body)); return new Response("{}", { status: 200 }); }) as typeof fetch });
  return { outcome, posted };
}

test("what leaves the machine is behaviour only: no free text, no raw id, no key outside the whitelist", async () => {
  seed();
  const { outcome, posted } = await send();
  expect(outcome).toMatchObject({ sent: expect.any(Number) });
  expect(posted).toHaveLength(1);
  const body = posted[0]!;
  for (const secret of [...SECRETS, RAW_ID, "tester@example.com", "Tester@Example.com"]) expect(body).not.toContain(secret);
  const batch = JSON.parse(body) as { install: string; account: string; version: string; sentAt: string; events: Array<Record<string, unknown>> };
  expect(Object.keys(batch).sort()).toEqual(["account", "events", "install", "sentAt", "version"]);
  expect(batch.account).toMatch(/^[0-9a-f]{64}$/);
  for (const event of batch.events) {
    for (const key of Object.keys(event)) expect(TELEMETRY_FIELDS).toContain(key);
    if (event.tokens) for (const key of Object.keys(event.tokens as object)) expect(TELEMETRY_TOKEN_FIELDS).toContain(key);
    if (event.counts) for (const key of Object.keys(event.counts as object)) expect(TELEMETRY_COUNT_FIELDS).toContain(key);
  }
  const types = new Set(batch.events.map((event) => event.type));
  expect(types.has("task.note")).toBe(false);
  // What is meant to arrive does arrive, in its coded form.
  expect(batch.events.find((event) => event.type === "work_order.transitioned")).toMatchObject({ stage: "active", entity: expect.stringMatching(/^[0-9a-f]{16}$/) });
  expect(batch.events.find((event) => event.type === "agent.task.blocked")).toMatchObject({ code: "AGENT_RUN_LOST" });
  expect(batch.events.find((event) => event.type === "skill.run" && event.skill === "crossline-onboarding"))
    .toMatchObject({ ok: false, code: "SKILL_STALLED", repairs: 2, ms: 4200, tokens: { input: 1200, cached: 300, output: 90 } });
  expect(batch.events.find((event) => event.type === "onboarding.round")).toMatchObject({ stage: "lines", counts: { rounds: 2 } });
  expect(batch.events.filter((event) => event.type === "page.viewed").map((event) => event.page)).toEqual(["/workbench/[id]", "/plan"]);
  expect(batch.events.some((event) => event.type === "install.started")).toBe(true);
});

test("a second pass sends only what is new, and a failed send loses nothing", async () => {
  seed();
  await send();
  expect((await send()).outcome).toEqual({ skipped: "NOTHING_NEW" });
  store.appendEvent({ ownerId: "o", workspaceId, idempotencyKey: "later", type: "capture.created", entityId: "c2", payload: { title: "x" } });
  const cursor = store.getSetting(workspaceId, TELEMETRY_CURSOR_SETTING);
  const failed = await telemetryPass({ store, workspaceId, dataDir, env: ENV, fetch: (async () => new Response("", { status: 503 })) as typeof fetch });
  expect(failed).toEqual({ failed: "HTTP_503" });
  expect(store.getSetting(workspaceId, TELEMETRY_CURSOR_SETTING)).toBe(cursor);
  const { posted } = await send();
  expect(JSON.parse(posted[0]!).events.map((event: { type: string }) => event.type)).toContain("capture.created");
});

test("nothing is sent from a development copy, or once the person turned it off — and turning it off drops waiting page views", async () => {
  seed();
  expect((await send({})).outcome).toEqual({ skipped: "NOT_INSTALLED" });
  store.setSetting(workspaceId, TELEMETRY_ENABLED_SETTING, "0");
  const { outcome, posted } = await send();
  expect(outcome).toEqual({ skipped: "TURNED_OFF" });
  expect(posted).toEqual([]);
  expect(existsSync(path.join(dataDir, "telemetry", "pages.jsonl.sending"))).toBe(false);
});

test("what happened while sending was off is never sent after it is turned back on", async () => {
  seed();
  store.setSetting(workspaceId, TELEMETRY_ENABLED_SETTING, "0");
  await send();
  store.setSetting(workspaceId, TELEMETRY_ENABLED_SETTING, "1");
  expect((await send()).outcome).toEqual({ skipped: "NOTHING_NEW" });
  store.appendEvent({ ownerId: "o", workspaceId, idempotencyKey: "after", type: "capture.created", entityId: "c3", payload: {} });
  const { posted } = await send();
  expect(JSON.parse(posted[0]!).events.map((event: { type: string }) => event.type)).toEqual(["capture.created", "counts.today"]);
});
