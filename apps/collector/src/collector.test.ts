import { readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { beforeEach, expect, test } from "vitest";
import worker, { REQUESTS_PER_HOUR, receiveEvents, receiveSnapshot, SNAPSHOTS_PER_DAY, verifyAccessJwt, type D1, type D1Statement, type D1Value, type Env } from "./index";
import { dashboardData, renderDashboard } from "./dashboard";

/**
 * The collector against a real SQLite with the real schema, through a small stand-in for D1's statement API. What is checked:
 * a tampered batch stores nothing outside the whitelist, the limits hold, a snapshot is stored as sent, and the dashboard is never
 * served without a verified Access token.
 */
function fakeD1(): D1 {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(path.join(import.meta.dirname, "..", "schema.sql"), "utf8"));
  const statement = (sql: string, values: D1Value[] = []): D1Statement => ({
    bind: (...next) => statement(sql, next),
    run: async () => db.prepare(sql).run(...values as never[]),
    all: async <T>() => ({ results: db.prepare(sql).all(...values as never[]) as T[] }),
    first: async <T>() => (db.prepare(sql).get(...values as never[]) ?? null) as T | null
  });
  return { prepare: (sql) => statement(sql), batch: async (statements) => Promise.all(statements.map((item) => item.run())) };
}

const INSTALL = "6b0c7f2e-2b7a-4c55-9c1e-8e5c2f0a4d11";
const AT = "2026-10-13T12:00:00.000Z";
let env: Env;
beforeEach(() => { env = { DB: fakeD1() }; });

const post = (pathname: string, body: string | Uint8Array, headers: Record<string, string> = {}) =>
  new Request(`https://collector.example${pathname}`, { method: "POST", body: typeof body === "string" ? body : new Uint8Array(body), headers });

test("a batch is stored only as the whitelist allows, whatever the client put in it", async () => {
  const batch = { install: INSTALL, account: "a".repeat(64), version: "0.2.0", sentAt: AT, extra: "Secret free text", events: [
    { type: "work_order.transitioned", at: AT, version: "0.2.0", stage: "active", entity: "0123456789abcdef", title: "Secret free text" },
    { type: "skill.run", at: AT, version: "0.2.0", skill: "crossline-onboarding", ok: false, code: "SKILL_STALLED", ms: 4200, repairs: 1,
      tokens: { input: 10, cached: 2, output: 3, note: "Secret free text" } },
    { type: "page.viewed", at: AT, version: "0.2.0", page: "/workbench/abc123" },
    { type: "conversation.message", at: AT, version: "0.2.0", text: "Secret free text" }] };
  const response = await receiveEvents(post("/v1/events", JSON.stringify(batch)), env, new Date(AT));
  expect(await response.json()).toEqual({ ok: true, accepted: 3 });
  const rows = (await env.DB.prepare("SELECT * FROM events ORDER BY id").all<Record<string, unknown>>()).results;
  expect(JSON.stringify(rows)).not.toContain("Secret free text");
  expect(rows.map((row) => row.type)).toEqual(["work_order.transitioned", "skill.run", "page.viewed"]);
  expect(rows[2]!.page).toBeNull();
  expect(rows[1]).toMatchObject({ skill: "crossline-onboarding", ok: 0, code: "SKILL_STALLED", input_tokens: 10, cached_tokens: 2, output_tokens: 3 });
  expect(await env.DB.prepare("SELECT account, version FROM installs").first()).toEqual({ account: "a".repeat(64), version: "0.2.0" });
});

test("an install over its hourly limit, a body that is too large, or one that is not a batch is refused", async () => {
  const batch = JSON.stringify({ install: INSTALL, version: "0.2.0", sentAt: AT, events: [] });
  for (let index = 0; index < REQUESTS_PER_HOUR; index += 1) expect((await receiveEvents(post("/v1/events", batch), env, new Date(AT))).status).toBe(200);
  expect((await receiveEvents(post("/v1/events", batch), env, new Date(AT))).status).toBe(429);
  expect((await receiveEvents(post("/v1/events", batch), env, new Date("2026-10-13T13:00:00.000Z"))).status).toBe(200);
  expect((await receiveEvents(post("/v1/events", "x".repeat(600 * 1024)), env)).status).toBe(413);
  expect((await receiveEvents(post("/v1/events", JSON.stringify({ install: "not an id", version: "0.2.0", sentAt: AT, events: [] })), env)).status).toBe(400);
});

test("a snapshot is kept exactly as sent, with its note, and limited per day", async () => {
  const body = gzipSync(JSON.stringify({ install: INSTALL, version: "0.2.0", createdAt: AT, feedback: "页面卡住了",
    snapshot: { format: "crossline.diagnostic-snapshot.v1", tables: {} } }));
  const headers = { "x-crossline-install": INSTALL };
  const first = await receiveSnapshot(post("/v1/snapshots", body, headers), env, new Date(AT));
  const answer = await first.json() as { ok: boolean; id: string };
  expect(answer.ok).toBe(true);
  const stored = await env.DB.prepare("SELECT feedback, bytes, body FROM snapshots WHERE id = ?").bind(answer.id).first<{ feedback: string; bytes: number; body: Uint8Array }>();
  expect(stored?.feedback).toBe("页面卡住了");
  expect(Buffer.from(stored!.body).equals(body)).toBe(true);
  for (let index = 1; index < SNAPSHOTS_PER_DAY; index += 1) expect((await receiveSnapshot(post("/v1/snapshots", body, headers), env, new Date(AT))).status).toBe(200);
  expect((await receiveSnapshot(post("/v1/snapshots", body, headers), env, new Date(AT))).status).toBe(429);
  // Another install's id in the header, a body that is not gzip, or not a snapshot: refused.
  expect((await receiveSnapshot(post("/v1/snapshots", body, { "x-crossline-install": "7b0c7f2e-2b7a-4c55-9c1e-8e5c2f0a4d11" }), env)).status).toBe(400);
  expect((await receiveSnapshot(post("/v1/snapshots", "plain", headers), env)).status).toBe(400);
  expect((await receiveSnapshot(post("/v1/snapshots", gzipSync(JSON.stringify({ install: INSTALL, version: "0.2.0", createdAt: AT, feedback: "", snapshot: {} })), headers), env)).status).toBe(400);
});

test("the dashboard is never served without a verified Access token", async () => {
  const get = (headers: Record<string, string> = {}) => worker.fetch(new Request("https://collector.example/dashboard", { headers }), env);
  expect((await get()).status).toBe(503);
  env = { ...env, ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com", ACCESS_AUD: "aud-1" };
  expect((await get()).status).toBe(403);
  expect((await get({ "cf-access-jwt-assertion": "a.b.c" })).status).toBe(403);
});

test("an Access token is accepted only with the team's signature, the right audience and issuer, and before it expires", async () => {
  const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1" };
  const team = "https://team.cloudflareaccess.com";
  const fetcher = (async () => Response.json({ keys: [jwk] })) as typeof fetch;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const sign = async (claims: Record<string, unknown>, privateKey = keys.privateKey) => {
    const unsigned = `${encode({ alg: "RS256", kid: "k1" })}.${encode(claims)}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(unsigned));
    return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
  };
  const now = Date.parse(AT);
  const good = { aud: ["aud-1"], iss: team, exp: now / 1000 + 600 };
  expect(await verifyAccessJwt(await sign(good), team, "aud-1", now, fetcher)).toBe(true);
  expect(await verifyAccessJwt(await sign({ ...good, aud: ["other"] }), team, "aud-1", now, fetcher)).toBe(false);
  expect(await verifyAccessJwt(await sign({ ...good, iss: "https://evil.example" }), team, "aud-1", now, fetcher)).toBe(false);
  expect(await verifyAccessJwt(await sign({ ...good, exp: now / 1000 - 1 }), team, "aud-1", now, fetcher)).toBe(false);
  const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  expect(await verifyAccessJwt(await sign(good, other.privateKey), team, "aud-1", now, fetcher)).toBe(false);
});

test("the dashboard counts the funnel, where work sits and how Skills run, and escapes everything it prints", async () => {
  const events = [
    { type: "install.started", at: AT, version: "0.2.0" },
    { type: "onboarding.round", at: AT, version: "0.2.0", stage: "lines", counts: { rounds: 2 } },
    { type: "capture.created", at: AT, version: "0.2.0", entity: "0123456789abcdef" },
    { type: "work_order.transitioned", at: "2026-10-12T09:00:00.000Z", version: "0.2.0", stage: "active", entity: "0123456789abcdef" },
    { type: "skill.run", at: AT, version: "0.2.0", skill: "crossline-onboarding", ok: true, ms: 2000, repairs: 1 },
    { type: "skill.run", at: AT, version: "0.2.0", skill: "crossline-onboarding", ok: false, ms: 4000, repairs: 0, code: "SKILL_STALLED" }];
  await receiveEvents(post("/v1/events", JSON.stringify({ install: INSTALL, version: "0.2.0", sentAt: AT, events })), env, new Date(AT));
  const data = await dashboardData(env.DB);
  expect(data.funnel.slice(0, 4)).toEqual([{ step: "安装", installs: 1 }, { step: "访谈·开场", installs: 1 }, { step: "访谈·主线", installs: 1 }, { step: "访谈·现状", installs: 0 }]);
  expect(data.funnel.find((step) => step.step === "首次收集")).toEqual({ step: "首次收集", installs: 1 });
  expect(data.stuck).toEqual([{ stage: "active", open: 1, oldest: "2026-10-12T09:00:00.000Z" }]);
  expect(data.skills[0]).toMatchObject({ skill: "crossline-onboarding", runs: 2, failed: 1, repaired: 1, averageMs: 3000, longestMs: 4000 });
  expect(data.errors).toEqual([{ code: "SKILL_STALLED", count: 1, installs: 1 }]);
  const html = renderDashboard({ ...data, snapshots: [{ id: INSTALL, install: INSTALL, version: "0.2.0", receivedAt: AT, bytes: 2048, feedback: "<script>alert(1)</script>" }] });
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});
