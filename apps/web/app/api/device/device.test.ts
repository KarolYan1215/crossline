import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { ACTIVITY_HOURLY, ACTIVITY_LONG_GAPS, INPUT_RHYTHM_BUCKETS, NODE_STATUS_SETTING, RECORDING_TRANSCRIBED_EVENT, RUNTIME_OWNER_SETTING, SLEEP_TRACKING_CONSENT, type AccessContext } from "@crossline/core";
vi.mock("server-only", () => ({}));
const session: { ctx?: AccessContext | undefined } = {};
vi.mock("../../../lib/access-guard", () => ({
  resolveAccessContext: vi.fn(async () => session.ctx ? { ctx: session.ctx } : { response: Response.json({ ok: false }, { status: 401 }) })
}));
import { issueDeviceToken } from "../../../lib/energy";
import { TEST_CTX } from "../../../lib/test-support";
import { POST as activity } from "./activity/route";
import { GET as computeStatus, POST as compute } from "./compute/route";
import { GET as linkStatus } from "./link/route";
import { GET as hello } from "./hello/route";
import { POST as recordings } from "./recordings/route";
import { POST as sources } from "./sources/route";
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

test("activity keeps no title and no app name, and a consent turned off deletes what it covered here", async () => {
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
  const events = store.listEvents(ctx.workspaceId, { type: RECORDING_TRANSCRIBED_EVENT });
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

test("「作为算力节点」: only the runtime owner's account may switch it on; the card shows what the hosted worker last saw of the node", async () => {
  const post = (enabled: boolean) => compute(new Request("https://app.crossline.lol/api/device/compute", { method: "POST", body: JSON.stringify({ enabled }) }));
  expect(await (await computeStatus(new Request("https://app.crossline.lol/api/device/compute"))).json()).toMatchObject({ available: false, enabled: false });
  expect((await post(true)).status).toBe(403);
  store.setSetting(ctx.workspaceId, RUNTIME_OWNER_SETTING, "1");
  expect(await (await post(true)).json()).toMatchObject({ ok: true, available: true, enabled: true });
  store.setSetting(ctx.workspaceId, NODE_STATUS_SETTING, JSON.stringify({ state: "ready", host: "KAROL-PC", codex: "0.163.0", at: "2026-10-23T18:00:00.000Z" }));
  expect(await (await computeStatus(new Request("https://app.crossline.lol/api/device/compute"))).json()).toMatchObject({ enabled: true, status: { state: "ready", host: "KAROL-PC" } });
  expect(await (await post(false)).json()).toMatchObject({ enabled: false });
  // A forged origin never switches it.
  expect((await compute(new Request("https://app.crossline.lol/api/device/compute", { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" }))).status).toBe(403);
});

test("while the background service restarts into the other mode, the device page is told so in plain words, not an error code", async () => {
  vi.stubEnv("CROSSLINE_SUPERVISOR_CAPABILITY_SECRET", "s".repeat(32));
  vi.stubEnv("CROSSLINE_CODEX_SUPERVISOR_URL", "http://127.0.0.1:9");
  const response = await linkStatus(new Request("http://127.0.0.1:3210/api/device/link"));
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ ok: false, code: "CODEX_SUPERVISOR_UNAVAILABLE", message: expect.stringContaining("可能正在重启") });
});
