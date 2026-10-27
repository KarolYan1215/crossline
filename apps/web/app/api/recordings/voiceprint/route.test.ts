import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { TEST_CTX } from "../../../../lib/test-support";
vi.mock("../../../../lib/access-guard", () => ({ resolveAccessContext: async () => ({ ctx: { ...TEST_CTX, workspaceId: current } }) }));
import { setVoiceprintConsent, voiceprintDir, voiceprintState } from "../../../../lib/recordings";
import { POST } from "./route";

let data: string;
let store: CrosslineStore;
let current = "";
beforeEach(() => {
  data = mkdtempSync(path.join(tmpdir(), "crossline-voiceprint-"));
  vi.stubEnv("CROSSLINE_DATA_DIR", data);
  store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  current = store.createPrincipalWithWorkspace("voice-owner", "个人").workspace.id;
});
afterEach(() => { store.close(); globalThis.crosslineStore = undefined; vi.unstubAllEnvs(); rmSync(data, { recursive: true, force: true }); });

const audio = Buffer.concat([Buffer.from([0, 0, 0, 0x1c]), Buffer.from("ftypM4A isomM4A mp42"), Buffer.alloc(100)]);
const upload = (body: BodyInit) => POST(new Request("http://127.0.0.1:3210/api/recordings/voiceprint", { method: "POST", body }));

test("a voiceprint recording is taken only with its own consent, waits as an enrolment, and the consent's end deletes it all", async () => {
  expect((await upload(audio)).status).toBe(403);
  setVoiceprintConsent(store, current, true, data);
  expect((await upload("not audio at all")).status).toBe(415);
  expect((await upload(audio)).status).toBe(200);
  expect(readdirSync(voiceprintDir(data))).toEqual([`${current}.enrol.m4a`]);
  expect(voiceprintState(store, current, data)).toMatchObject({ on: true, state: "pending" });
  // What the transcriber leaves once it has made the voiceprint.
  rmSync(path.join(voiceprintDir(data), `${current}.enrol.m4a`));
  writeFileSync(path.join(voiceprintDir(data), `${current}.json`), JSON.stringify({ vector: [1, 0], seconds: 40, at: "2026-10-21T08:00:00Z" }));
  expect(voiceprintState(store, current, data)).toMatchObject({ state: "ready", seconds: 40 });
  expect(setVoiceprintConsent(store, current, false, data)).toEqual({ deleted: 1 });
  expect(existsSync(path.join(voiceprintDir(data), `${current}.json`))).toBe(false);
  expect(voiceprintState(store, current, data)).toEqual({ on: false, state: "none" });
});
