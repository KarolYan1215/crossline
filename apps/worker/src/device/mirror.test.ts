import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RECORDING_TRANSCRIBED_EVENT, SOURCE_FOLDERS_SETTING, sourceFolderIndexSetting } from "@crossline/core";
import { CrosslineStore, mirrorSnapshot } from "@crossline/db";
import { installVersion, mirrorPass } from "./mirror";
import { readDeviceState } from "./payloads";

let dir: string;
let server: CrosslineStore;
let local: CrosslineStore;
let sw: string;
let lw: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "crossline-mirror-"));
  server = new CrosslineStore(":memory:");
  sw = server.createPrincipalWithWorkspace("hosted", "个人").workspace.id;
  local = new CrosslineStore(path.join(dir, "crossline.db"));
  lw = local.createPrincipalWithWorkspace("local", "个人").workspace.id;
});
afterEach(() => { server.close(); local.close(); rmSync(dir, { recursive: true, force: true }); });

/** The hosted route in miniature: the mirror gzipped, its ETag, and 304 for the same one. */
const site = (status?: number) => {
  const calls: Array<string | null> = [];
  const fetchImpl = (async (_url: URL, init: { headers: Record<string, string> }) => {
    calls.push(init.headers["if-none-match"] ?? null);
    if (status) return new Response("{}", { status });
    const json = JSON.stringify(mirrorSnapshot(server, sw));
    const etag = `"${createHash("sha256").update(json).digest("hex")}"`;
    if (init.headers["if-none-match"] === etag) return new Response(null, { status: 304 });
    return new Response(new Uint8Array(gzipSync(json)), { headers: { etag } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
};
const link = { url: "https://app.crossline.lol", token: "t".repeat(32) };
const ledger = () => path.join(dir, "crossline.db");

test("the device takes the site's ledger, keeps its folder files and its own transcripts, and asks with the ETag next time", async () => {
  server.setSetting(sw, "schedule.lineShares", "{\"research\":50}");
  server.appendEvent({ ownerId: server.getWorkspaceOwnerId(sw)!, workspaceId: sw, idempotencyKey: "recording.transcribed:" + "f".repeat(64),
    type: RECORDING_TRANSCRIBED_EVENT, entityId: "f".repeat(64), payload: { where: "server" } });
  const owner = local.getWorkspaceOwnerId(lw)!;
  local.saveSourceDocument({ id: "folder-doc", ownerId: owner, workspaceId: lw, kind: "text", fileName: "a.txt", mediaType: "text/plain", sha256: "a".repeat(64),
    uri: "file:///a.txt", extractedText: "a", extractionStatus: "done", createdAt: "2026-11-01T00:00:00.000Z" });
  local.setSetting(lw, SOURCE_FOLDERS_SETTING, JSON.stringify([{ id: "f1", path: "C:/notes", label: "notes", addedAt: "2026-11-01T00:00:00.000Z" }]));
  local.setSetting(lw, sourceFolderIndexSetting("f1"), JSON.stringify({ "a.txt": { documentId: "folder-doc", size: 1, mtimeMs: 1 } }));
  const state = readDeviceState(path.join(dir, "device"));
  state.recordings = ["e".repeat(64)];
  const { calls, fetchImpl } = site();

  const first = await mirrorPass({ store: local, ledger: ledger(), workspaceId: lw, link, state, fetch: fetchImpl, now: new Date("2026-11-03T10:00:00Z") });
  expect(first.error).toBeUndefined();
  expect(local.getSetting(lw, "schedule.lineShares")).toBe("{\"research\":50}");
  expect(local.listSourceDocuments(lw).map((doc) => doc.id)).toEqual(["folder-doc"]);
  // What the site transcribed itself is never this device's to send up.
  expect(state.recordings.sort()).toEqual(["e".repeat(64), "f".repeat(64)]);
  expect(readdirSync(dir).filter((name) => name.includes(".mirror-"))).toEqual(["crossline.db.mirror-2026-11-03.bak"]);

  // Unchanged: a 304, nothing written.
  const second = await mirrorPass({ store: local, ledger: ledger(), workspaceId: lw, link, state, fetch: fetchImpl, now: new Date("2026-11-03T10:10:00Z") });
  expect(calls[1]).toBe(first.etag);
  expect(second).toMatchObject({ at: first.at, checkedAt: "2026-11-03T10:10:00.000Z" });
});

test("a failure is recorded and the next pass asks again without the ETag; backups keep three days", async () => {
  const state = readDeviceState(path.join(dir, "device"));
  const down = site(503);
  const failed = await mirrorPass({ store: local, ledger: ledger(), workspaceId: lw, link, state, fetch: down.fetchImpl, now: new Date("2026-11-03T10:00:00Z") });
  expect(failed.error).toBe("DEVICE_MIRROR_HTTP_503");
  expect(await mirrorPass({ store: local, ledger: ledger(), workspaceId: lw, link: { ...link, token: undefined }, state })).toMatchObject({ error: "DEVICE_TOKEN_UNREADABLE" });

  const up = site();
  for (const day of ["01", "02", "03", "04"]) {
    server.setSetting(sw, "schedule.lineShares", day);
    const done = await mirrorPass({ store: local, ledger: ledger(), workspaceId: lw, link, state, fetch: up.fetchImpl, now: new Date(`2026-11-${day}T10:00:00Z`) });
    expect(done.error).toBeUndefined();
  }
  expect(up.calls.at(-1)).not.toBeNull();
  expect(local.getSetting(lw, "schedule.lineShares")).toBe("04");
  expect(readdirSync(dir).filter((name) => name.includes(".mirror-")).sort()).toEqual(["02", "03", "04"].map((day) => `crossline.db.mirror-2026-11-${day}.bak`));
  // After a failure the whole ledger is asked for again, not "what changed since".
  await mirrorPass({ store: local, ledger: ledger(), workspaceId: lw, link, state, fetch: down.fetchImpl });
  await mirrorPass({ store: local, ledger: ledger(), workspaceId: lw, link, state, fetch: up.fetchImpl });
  expect(up.calls.at(-1)).toBeNull();
  expect(state.mirror?.error).toBeUndefined();
});

test("a site ledger newer than this install says to update, and is not fetched again until the install changes", async () => {
  // A table the install does not know: the site moved on to a migration this computer has not got yet.
  const calls: number[] = [];
  const fetchImpl = (async () => {
    calls.push(1);
    const mirror = mirrorSnapshot(server, sw) as unknown as { tables: Record<string, unknown[]> };
    mirror.tables.future_table = [{ workspace_id: sw, id: "x" }];
    return new Response(new Uint8Array(gzipSync(JSON.stringify(mirror))), { headers: { etag: "\"e\"" } });
  }) as unknown as typeof fetch;
  const state = readDeviceState(path.join(dir, "device"));
  const first = await mirrorPass({ store: local, ledger: ledger(), workspaceId: lw, link, state, fetch: fetchImpl });
  expect(first).toMatchObject({ code: "DEVICE_INSTALL_OUTDATED", error: "需要更新这台电脑上的 Crossline", outdated: installVersion(local) });
  await mirrorPass({ store: local, ledger: ledger(), workspaceId: lw, link, state, fetch: fetchImpl });
  expect(calls).toHaveLength(1);
  // Updated: the next pass asks again.
  const previous = process.env.CROSSLINE_APP_VERSION;
  process.env.CROSSLINE_APP_VERSION = "9.9.9";
  try { await mirrorPass({ store: local, ledger: ledger(), workspaceId: lw, link, state, fetch: fetchImpl }); }
  finally { if (previous === undefined) delete process.env.CROSSLINE_APP_VERSION; else process.env.CROSSLINE_APP_VERSION = previous; }
  expect(calls).toHaveLength(2);
});
