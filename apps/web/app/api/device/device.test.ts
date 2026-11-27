import { mkdtempSync, rmSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ACTIVITY_HOURLY, ACTIVITY_LONG_GAPS, INPUT_RHYTHM_BUCKETS, NODE_STATUS_SETTING, RUNTIME_OWNER_SETTING, SLEEP_TRACKING_CONSENT, type AccessContext } from "@crossline/core";
vi.mock("server-only", () => ({}));
const session: { ctx?: AccessContext | undefined } = {};
vi.mock("../../../lib/access-guard", () => ({
  resolveAccessContext: vi.fn(async () => session.ctx ? { ctx: session.ctx } : { response: Response.json({ ok: false }, { status: 401 }) })
}));
import { issueDeviceToken } from "../../../lib/energy";
import { TEST_CTX } from "../../../lib/test-support";
import { POST as activity } from "./activity/route";
import { POST as commits } from "./commits/route";
import { GET as computeStatus, POST as compute } from "./compute/route";
import { GET as linkStatus, POST as link } from "./link/route";
import { POST as nodeSwitch } from "./node/route";
import { GET as hello } from "./hello/route";
import { POST as recordings } from "./recordings/route";
import { POST as sources } from "./sources/route";
import { GET as snapshot } from "./snapshot/route";
import { DELETE as revoke, GET as status, POST as issue } from "./token/route";

let data: string;
let store: CrosslineStore;
let ctx: AccessContext;
beforeEach(() => {
  data = mkdtempSync(path.join(tmpdir(), "crossline-device-"));
  vi.stubEnv("CROSSLINE_DATA_DIR", data);
  store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const { workspace } = store.createPrincipalWithWorkspace("hosted-owner", "个人");
  ctx = { ...TEST_CTX, workspaceId: workspace.id, principalId: store.getWorkspaceOwnerId(workspace.id)! };
  session.ctx = ctx;
});
afterEach(() => { store.close(); globalThis.crosslineStore = undefined; session.ctx = undefined; vi.unstubAllEnvs(); rmSync(data, { recursive: true, force: true }); });

const send = (handler: (request: Request) => Promise<Response>, route: string, token: string, key: string, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request(`https://app.crossline.lol${route}`, { method: "POST", body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": key, ...headers } }));
const sha = (char: string) => char.repeat(64);
const consents = { activity: true, detail: true, sleep: true, rhythm: true, agentHistory: false };

test("only the device token sends, and a request without an idempotency key is refused", async () => {
  const capture = issueDeviceToken(ctx, "capture");
  expect((await send(activity, "/api/device/activity", capture, "activity:aaaaaaaa", { consents })).status).toBe(401);
  const device = issueDeviceToken(ctx, "device");
  expect((await send(activity, "/api/device/activity", device, "activity:aaaaaaaa", { consents })).status).toBe(200);
  const noKey = await activity(new Request("https://app.crossline.lol/api/device/activity", { method: "POST", body: "{}",
    headers: { authorization: `Bearer ${device}`, "content-type": "application/json" } }));
  expect(noKey.status).toBe(400);
  // A device token cannot capture or upload recordings: it opens these routes only.
  expect((await hello(new Request("https://app.crossline.lol/api/device/hello", { headers: { authorization: `Bearer ${device}` } }))).status).toBe(200);
  expect((await hello(new Request("https://app.crossline.lol/api/device/hello", { headers: { authorization: `Bearer ${capture}` } }))).status).toBe(401);
});

test("activity keeps no app name and only the device's (masked) titles, and a consent turned off deletes what it covered here", async () => {
  const device = issueDeviceToken(ctx, "device");
  const body = {
    consents,
    daily: [{ day: "2026-10-21", activeMinutes: 300, idleMinutes: 60, windowSwitches: 40, sampleCount: 360 }],
    hourly: [{ start: "2026-10-21T14:00:00.000Z", active: 50, idle: 10 }],
    gaps: [{ from: "2026-10-21T05:00:00.000Z", to: "2026-10-21T13:00:00.000Z" }],
    rhythm: [{ start: "2026-10-21T14:00:00.000Z", minutes: 15, activeSec: 600, pauses: 12, mousePx: 4000 }],
    segmentsSince: "2026-10-21T00:00:00.000Z",
    segments: [
      { start: "2026-10-21T14:00:00.000Z", end: "2026-10-21T14:30:00.000Z", category: "writing", idle: false, app: "WINWORD.EXE", title: "离婚协议.docx" },
      { start: "2026-10-21T14:30:00.000Z", end: "2026-10-21T15:00:00.000Z", category: "coding", idle: false, app: "a1b2c3d4" }
    ],
    secret: "anything else"
  };
  expect(await (await send(activity, "/api/device/activity", device, "activity:one11111", body)).json()).toMatchObject({ ok: true, segments: 2 });
  const kept = store.recentActivityEntries(ctx.workspaceId, 10);
  expect(kept.map((entry) => [entry.app, entry.title, entry.category])).toEqual([["a1b2c3d4", "", "coding"], ["", "", "writing"]]);
  expect(JSON.stringify(kept)).not.toContain("WINWORD");
  expect(store.listEnergyObservations(ctx.workspaceId).find((item) => item.id === "local-activity:2026-10-21")?.aggregate).toMatchObject({ activeMinutes: 300 });
  expect(JSON.parse(store.getSetting(ctx.workspaceId, ACTIVITY_LONG_GAPS)!)).toHaveLength(1);
  expect(store.getSetting(ctx.workspaceId, SLEEP_TRACKING_CONSENT)).toBe("granted");

  // The device turned 作息记录, 键鼠节律 and the detailed level off: those go here too; the hourly minutes stay under the daily consent.
  await send(activity, "/api/device/activity", device, "activity:two22222", { ...body, consents: { ...consents, detail: false, sleep: false, rhythm: false } });
  expect(store.getSetting(ctx.workspaceId, ACTIVITY_LONG_GAPS)).toBeUndefined();
  expect(store.getSetting(ctx.workspaceId, INPUT_RHYTHM_BUCKETS)).toBeUndefined();
  expect(store.recentActivityEntries(ctx.workspaceId, 10)).toEqual([]);
  expect(store.getSetting(ctx.workspaceId, ACTIVITY_HOURLY)).toBeDefined();
});

test("segments with titles are kept one row per start and app: a resend or a grown segment updates it; old titles are blanked here too", async () => {
  const device = issueDeviceToken(ctx, "device");
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
  const segments = [
    { start: ago(60), end: ago(50), category: "writing", idle: false, app: "a1b2c3d4", title: "Cover letter.docx - Word" },
    { start: ago(50), end: ago(40), category: "coding", idle: false, app: "b2c3d4e5", title: "[仅本地]" },
    { start: ago(20 * 1440), end: ago(20 * 1440 - 5), category: "reading", idle: false, app: "c3d4e5f6", title: "old title" }
  ];
  expect(await (await send(activity, "/api/device/activity", device, "activity:tt111111", { consents, segmentsSince: ago(30 * 1440), segments })).json()).toMatchObject({ segments: 3 });
  // Sent again under another key, the last segment grown: still three rows, the grown one's end moved.
  const grown = [...segments.slice(0, 2), { ...segments[1]!, start: ago(40), end: ago(1), app: "a1b2c3d4", title: "Cover letter.docx - Word" }];
  await send(activity, "/api/device/activity", device, "activity:tt222222", { consents, segments: [...segments, ...grown] });
  await send(activity, "/api/device/activity", device, "activity:tt333333", { consents, segments: [...segments, { ...grown[2]!, end: ago(0) }] });
  const kept = store.recentActivityEntries(ctx.workspaceId, 10).sort((a, b) => a.start.localeCompare(b.start));
  expect(kept.map((entry) => [entry.app, entry.title])).toEqual([["c3d4e5f6", ""], ["a1b2c3d4", "Cover letter.docx - Word"], ["b2c3d4e5", "[仅本地]"], ["a1b2c3d4", "Cover letter.docx - Word"]]);
  expect(Date.parse(kept.at(-1)!.end)).toBeGreaterThan(Date.now() - 60_000);
});

test("commits become one git.commit_seen event each, by repository and id, and a resend adds none", async () => {
  const device = issueDeviceToken(ctx, "device");
  const commit = { repo: "thesis", sha: "a".repeat(40), at: "2026-11-24T10:00:00+08:00", subject: "Draft intro\nbody", files: ["paper/intro.tex", "[仅本地]"], onDefaultBranch: true,
    diff: "never kept" };
  expect(await (await send(commits, "/api/device/commits", device, "commits:c1c1c1c1", { commits: [commit, { ...commit, sha: "not-a-sha" }] })).json()).toMatchObject({ added: 1, existing: 0 });
  expect(await (await send(commits, "/api/device/commits", device, "commits:c1c1c1c1", { commits: [commit] })).json()).toMatchObject({ duplicate: true });
  expect(await (await send(commits, "/api/device/commits", device, "commits:c2c2c2c2", { commits: [commit] })).json()).toMatchObject({ added: 0, existing: 1 });
  const events = store.listEvents(ctx.workspaceId, { type: "git.commit_seen" });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ entityId: "a".repeat(40), idempotencyKey: `git.commit_seen:thesis:${"a".repeat(40)}`,
    payload: { repo: "thesis", sha: "a".repeat(40), at: "2026-11-24T02:00:00.000Z", subject: "Draft intro", files: ["paper/intro.tex", "[仅本地]"], onDefaultBranch: true } });
  expect(JSON.stringify(events)).not.toContain("never kept");
  expect((await send(commits, "/api/device/commits", issueDeviceToken(ctx, "capture"), "commits:c3c3c3c3", { commits: [commit] })).status).toBe(401);
});

test("a repeated key is applied once, a file is kept once by its sha256, and only a device's own file is removed", async () => {
  const device = issueDeviceToken(ctx, "device");
  const doc = { sha256: sha("a"), fileName: "Downloads/ECE555 syllabus.pdf", folderId: "f1", status: "done", text: "ECE 555 Final project report due December 12.", createdAt: "2026-10-21T10:00:00.000Z" };
  const body = { folders: [{ id: "f1", label: "Downloads", lines: ["research"], files: 1, path: "C:\\Users\\karol\\Downloads" }], documents: [doc] };
  expect(await (await send(sources, "/api/device/sources", device, "sources:k1k1k1k1", body)).json()).toMatchObject({ saved: 1 });
  expect(await (await send(sources, "/api/device/sources", device, "sources:k1k1k1k1", body)).json()).toMatchObject({ duplicate: true });
  expect(await (await send(sources, "/api/device/sources", device, "sources:k2k2k2k2", body)).json()).toMatchObject({ saved: 0, existing: 1 });
  const saved = store.listSourceDocuments(ctx.workspaceId);
  expect(saved.map((item) => [item.fileName, item.kind, item.extractedText])).toEqual([["Downloads/ECE555 syllabus.pdf.txt", "text", doc.text]]);
  // The folder's path on that machine is never kept here.
  expect(JSON.stringify(store.getSetting(ctx.workspaceId, "device.folders"))).not.toContain("karol");
  // A removal of a file the device never sent (an upload with the same content would be) touches nothing.
  expect(await (await send(sources, "/api/device/sources", device, "remove:r0r0r0r0", { remove: [sha("b")] })).json()).toMatchObject({ removed: 0 });
  expect(await (await send(sources, "/api/device/sources", device, "remove:r1r1r1r1", { remove: [sha("a")] })).json()).toMatchObject({ removed: 1 });
  expect(store.listSourceDocuments(ctx.workspaceId)).toEqual([]);
});

test("a transcript becomes the same recording.transcribed event the machine writes, once per audio", async () => {
  const device = issueDeviceToken(ctx, "device");
  const transcript = { audioSha: sha("c"), fileName: "2026-10-21 09.30.m4a", label: "录音", folderId: "f2", text: "[录音：2026-10-21 09.30.m4a]\n[00:01] 明天下午三点交报告。",
    seconds: 600, speechSeconds: 300, workMs: 40_000, wallMs: 50_000 };
  expect(await (await send(recordings, "/api/device/recordings", device, "recordings:aaaa1111", { transcripts: [transcript] })).json()).toMatchObject({ transcripts: 1 });
  expect(await (await send(recordings, "/api/device/recordings", device, "recordings:bbbb2222", { transcripts: [transcript] })).json()).toMatchObject({ transcripts: 0 });
  const events = store.listEvents(ctx.workspaceId, { type: "recording.changed", change: "transcribed" });
  expect(events).toHaveLength(1);
  expect(events[0]!.entityId).toBe(sha("c"));
  expect(store.listSourceDocuments(ctx.workspaceId).map((item) => item.fileName)).toEqual(["录音/2026-10-21 09.30.m4a 转写.txt"]);
});

test("the 这台电脑 card makes, shows and revokes the token; a revoked token is refused at once", async () => {
  const made = await (await issue(new Request("https://app.crossline.lol/api/device/token", { method: "POST" }))).json() as { token: string };
  expect(made.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  await send(activity, "/api/device/activity", made.token, "activity:seen0000", { consents }, { "x-crossline-device": "KAROL-PC" });
  const shown = await (await status(new Request("https://app.crossline.lol/api/device/token"))).json() as { linked: boolean; lastSeen: { label?: string } | null };
  expect(shown).toMatchObject({ linked: true, lastSeen: { label: "KAROL-PC" } });
  await revoke(new Request("https://app.crossline.lol/api/device/token", { method: "DELETE" }));
  expect((await send(activity, "/api/device/activity", made.token, "activity:after000", { consents })).status).toBe(401);
});

test("「作为算力节点」: any account may switch it on for itself (方案 C); the card shows what the hosted worker last saw of the node", async () => {
  const post = (enabled: boolean) => compute(new Request("https://app.crossline.lol/api/device/compute", { method: "POST", body: JSON.stringify({ enabled }) }));
  expect(await (await computeStatus(new Request("https://app.crossline.lol/api/device/compute"))).json()).toMatchObject({ available: true, enabled: false });
  expect(await (await post(true)).json()).toMatchObject({ ok: true, available: true, enabled: true });
  store.setSetting(ctx.workspaceId, NODE_STATUS_SETTING, JSON.stringify({ state: "ready", host: "KAROL-PC", codex: "0.163.0", at: "2026-10-23T18:00:00.000Z" }));
  expect(await (await computeStatus(new Request("https://app.crossline.lol/api/device/compute"))).json()).toMatchObject({ enabled: true, status: { state: "ready", host: "KAROL-PC" } });
  expect(await (await post(false)).json()).toMatchObject({ enabled: false });
  // A forged origin never switches it.
  expect((await compute(new Request("https://app.crossline.lol/api/device/compute", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }))).status).toBe(403);
});

test("on the hosted site, and on an install that is not a linked device, there is no device link or node switch to reach", async () => {
  const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  vi.stubEnv("CROSSLINE_PUBLIC_BETA", "1");
  expect((await linkStatus(new Request("https://app.crossline.lol/api/device/link"))).status).toBe(404);
  expect((await link(new Request("https://app.crossline.lol/api/device/link", json({ url: "https://evil.example", token: "t".repeat(32) })))).status).toBe(404);
  expect((await nodeSwitch(new Request("https://app.crossline.lol/api/device/node", json({ enabled: true })))).status).toBe(404);
  vi.stubEnv("CROSSLINE_PUBLIC_BETA", "");
  expect((await nodeSwitch(new Request("http://127.0.0.1:3210/api/device/node", json({ enabled: true })))).status).toBe(404);
});

test("while the background service restarts into the other mode, the device page is told so in plain words, not an error code", async () => {
  vi.stubEnv("CROSSLINE_SUPERVISOR_CAPABILITY_SECRET", "s".repeat(32));
  vi.stubEnv("CROSSLINE_CODEX_SUPERVISOR_URL", "http://127.0.0.1:9");
  const response = await linkStatus(new Request("http://127.0.0.1:3210/api/device/link"));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, code: "CODEX_SUPERVISOR_UNAVAILABLE", message: expect.stringContaining("可能正在重启") });
});

test("the mirror goes to the device token only, without the machine's settings or token hashes, and answers 304 when nothing changed", async () => {
  const get = (token: string, etag?: string) => snapshot(new Request("https://app.crossline.lol/api/device/snapshot",
    { headers: { authorization: `Bearer ${token}`, ...(etag ? { "if-none-match": etag } : {}) } }));
  expect((await snapshot(new Request("https://app.crossline.lol/api/device/snapshot"))).status).toBe(401);
  expect((await get(issueDeviceToken(ctx, "capture"))).status).toBe(401);
  const device = issueDeviceToken(ctx, "device");
  store.setSetting(ctx.workspaceId, "schedule.lineShares", "{}");
  store.setSetting(ctx.workspaceId, RUNTIME_OWNER_SETTING, "1");
  const first = await get(device);
  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toBe("application/gzip");
  const body = JSON.parse(gunzipSync(Buffer.from(await first.arrayBuffer())).toString("utf8")) as { workspaceId: string; tables: Record<string, Array<{ key?: string }>> };
  expect(body.workspaceId).toBe(ctx.workspaceId);
  const keys = body.tables.settings!.map((row) => row.key);
  expect(keys).toContain("schedule.lineShares");
  expect(keys.filter((key) => key!.endsWith(".token.sha256") || key!.startsWith("device.") || key === RUNTIME_OWNER_SETTING)).toEqual([]);
  expect(body.tables.principals).toBeUndefined();
  // The same ledger is a 304, though this very request wrote the device's own bookkeeping; a change is a new body (not before a minute).
  const etag = first.headers.get("etag")!;
  expect((await get(device, etag)).status).toBe(304);
  store.setSetting(ctx.workspaceId, "schedule.lineShares", "{\"research\":50}");
  expect((await get(device, etag)).status).toBe(429);
});
