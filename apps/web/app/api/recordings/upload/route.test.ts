import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { RECORDING_SERVER_CONSENT } from "@crossline/core";
vi.mock("server-only", () => ({}));
import { issueDeviceToken } from "../../../../lib/energy";
import { setServerRecordingConsent } from "../../../../lib/recordings";
import { TEST_CTX } from "../../../../lib/test-support";
import { POST } from "./route";

let data: string;
let store: CrosslineStore;
let workspaceId: string;
beforeEach(() => {
  data = mkdtempSync(path.join(tmpdir(), "crossline-upload-"));
  vi.stubEnv("CROSSLINE_DATA_DIR", data);
  store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("phone-owner", "个人").workspace.id;
});
afterEach(() => { store.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); rmSync(data, { recursive: true, force: true }); });

const send = (bearer: string, body: BodyInit, name = "2026-10-20 09.30.m4a", headers: Record<string, string> = {}) =>
  POST(new Request(`http://127.0.0.1:3210/api/recordings/upload?name=${encodeURIComponent(name)}`, { method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "audio/mp4", ...headers }, body }));
const inbox = () => path.join(data, "recordings", "inbox", workspaceId);

test("only the recording token uploads, only with the server consent on, and the file waits in the inbox with its name", async () => {
  const ctx = { ...TEST_CTX, workspaceId };
  const capture = issueDeviceToken(ctx, "capture"), recording = issueDeviceToken(ctx, "recording");
  expect((await send(capture, "audio")).status).toBe(401);
  expect((await send(recording, "audio")).status).toBe(403);
  store.setSetting(workspaceId, RECORDING_SERVER_CONSENT, "granted");
  expect((await send(recording, "audio bytes")).status).toBe(200);
  const files = readdirSync(inbox()).sort();
  expect(files).toHaveLength(2);
  expect(files[0]).toMatch(/^\d+-[0-9a-f]{8}\.m4a$/);
  expect(readFileSync(path.join(inbox(), files[0]!), "utf8")).toBe("audio bytes");
  expect(JSON.parse(readFileSync(path.join(inbox(), files[1]!), "utf8"))).toEqual({ name: "2026-10-20 09.30.m4a", size: 11 });
  expect((await send(recording, "x", "notes.txt", { "content-type": "text/plain" })).status).toBe(415);
  expect((await send(recording, "x", "a.m4a", { "content-length": String(400 * 1024 * 1024) })).status).toBe(413);
  // Turned off: uploads are refused again and what was waiting is deleted.
  expect(setServerRecordingConsent(store, workspaceId, false, { keep: true, dataDir: data, ownerId: ctx.principalId })).toEqual({ deleted: 0, discarded: 1 });
  expect(existsSync(inbox())).toBe(false);
  expect((await send(recording, "audio")).status).toBe(403);
});
