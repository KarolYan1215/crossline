import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { RECORDING_SERVER_CONSENT, RECORDING_SILENT_EVENT, RECORDING_TRANSCRIBED_EVENT, inTranscribeWindow } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { RECORDING_FAILED_EVENT, inboxDir, processInbox, type InboxDeps } from "./recording-inbox";
import { transcribeBlocks, type BlockTranscript } from "./sensevoice";
import { RATE, signal } from "./testing/audio";

let store: CrosslineStore;
let workspaceId: string;
let data: string;
const NIGHT = new Date("2026-10-21T07:00:00Z"); // 02:00 in Chicago
const DAY = new Date("2026-10-21T17:00:00Z");

const upload = (stamp: number, content: string, name?: string) => {
  const dir = inboxDir(data, workspaceId);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${stamp}-x${stamp}.m4a`);
  writeFileSync(file, content);
  if (name) writeFileSync(`${file}.json`, JSON.stringify({ name }));
  return file;
};
const waiting = () => { try { return readdirSync(inboxDir(data, workspaceId)); } catch { return []; } };
const deps = (results: Record<string, BlockTranscript | Error>, at = NIGHT, heard: string[] = []): InboxDeps => ({
  dataDir: data, timeZone: "America/Chicago", now: () => at, recognise: () => async () => ({ text: "", lang: "" }),
  transcribe: async (file) => {
    const key = Object.keys(results).find((stamp) => path.basename(file).startsWith(stamp))!;
    heard.push(key);
    const result = results[key]!;
    if (result instanceof Error) throw result;
    return result;
  }
});
const spoken: BlockTranscript = { state: "transcribed", text: "[语言：中文，自动识别]\n[00:20] 我周五之前把初稿发给王老师", seconds: 1800, speechSeconds: 300, workMs: 40_000 };

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("user-1", "个人").workspace.id;
  data = mkdtempSync(path.join(tmpdir(), "crossline-inbox-"));
});
afterEach(() => { store.close(); rmSync(data, { recursive: true, force: true }); });

test("nothing is read without the consent, or outside the night", async () => {
  upload(1000, "a");
  expect(await processInbox(store, workspaceId, deps({ "1000": spoken }))).toEqual([]);
  store.setSetting(workspaceId, RECORDING_SERVER_CONSENT, "granted");
  expect(await processInbox(store, workspaceId, deps({ "1000": spoken }, DAY))).toEqual([]);
  expect(waiting()).toHaveLength(1);
});

test("in the night each upload becomes a transcript, a silence, a failure or a known copy — and its audio is deleted every time", async () => {
  store.setSetting(workspaceId, RECORDING_SERVER_CONSENT, "granted");
  upload(1000, "same audio", "组会.m4a");
  upload(2000, "quiet");
  upload(3000, "broken");
  upload(4000, "same audio");
  const heard: string[] = [];
  const outcomes = await processInbox(store, workspaceId, deps({ "1000": spoken, "2000": { state: "silent", text: "", seconds: 600, speechSeconds: 0, workMs: 100 },
    "3000": new Error("ffmpeg 读不了这个录音"), "4000": spoken }, NIGHT, heard));
  expect(outcomes.map((item) => `${item.name}:${item.state}`)).toEqual(["组会.m4a:transcribed", "录音.m4a:silent", "录音.m4a:failed", "录音.m4a:duplicate"]);
  expect(heard).toEqual(["1000", "2000", "3000"]);
  expect(waiting()).toEqual([]);
  const doc = store.listSourceDocuments(workspaceId)[0]!;
  expect(doc).toMatchObject({ fileName: "手机上传/组会.m4a 转写.txt", kind: "text" });
  expect(doc.extractedText).toContain("[00:20] 我周五之前把初稿发给王老师");
  expect(doc.extractionNote).toContain("服务器转写");
  expect(store.listEvents(workspaceId, { type: RECORDING_TRANSCRIBED_EVENT })[0]!.payload).toMatchObject({ where: "server", engine: "sensevoice-small" });
  expect(store.listEvents(workspaceId, { type: RECORDING_SILENT_EVENT })).toHaveLength(1);
  expect(store.listEvents(workspaceId, { type: RECORDING_FAILED_EVENT })[0]!.payload).toMatchObject({ message: "ffmpeg 读不了这个录音" });
});

test("a recording cut off by morning or by the consent is kept for the next night, and nothing of it is stored", async () => {
  store.setSetting(workspaceId, RECORDING_SERVER_CONSENT, "granted");
  const file = upload(1000, "a");
  expect(await processInbox(store, workspaceId, deps({ "1000": { state: "stopped" } }))).toEqual([{ state: "stopped", name: "录音.m4a" }]);
  expect(existsSync(file)).toBe(true);
  expect(store.listSourceDocuments(workspaceId)).toEqual([]);
});

test("the night window is read in the person's zone and may cross midnight", () => {
  expect(inTranscribeWindow(NIGHT, "America/Chicago")).toBe(true);
  expect(inTranscribeWindow(DAY, "America/Chicago")).toBe(false);
  expect(inTranscribeWindow(new Date("2026-10-21T04:30:00Z"), "America/Chicago", "23:00-01:00")).toBe(true);
  expect(inTranscribeWindow(new Date("2026-10-21T06:30:00Z"), "America/Chicago", "23:00-01:00")).toBe(false);
  expect(inTranscribeWindow(NIGHT, "America/Chicago", "nonsense")).toBe(true);
});

test("blocks are transcribed speech window by window, at their time in the recording, and silence never reaches the model", async () => {
  const lengths: number[] = [];
  async function* blocks() { yield signal(60, [[10, 50]]); yield signal(60, []); yield signal(30, [[5, 8]]); }
  const result = await transcribeBlocks(blocks(), async (samples) => { lengths.push(samples.length / RATE); return { text: `第 ${lengths.length} 段`, lang: "zh" }; });
  expect(lengths.every((seconds) => seconds <= 20)).toBe(true);
  expect(lengths.length).toBe(4);
  expect(result).toMatchObject({ state: "transcribed", seconds: 150, language: "zh" });
  if (result.state === "stopped") throw new Error("stopped");
  expect(result.text.split("\n").slice(1).map((line) => line.slice(0, 7))).toEqual(["[00:09]", "[00:29]", "[00:49]", "[02:04]"]);
  async function* quiet() { yield signal(60, []); }
  expect(await transcribeBlocks(quiet(), async () => { throw new Error("must not be called"); })).toMatchObject({ state: "silent" });
  let calls = 0;
  expect(await transcribeBlocks(blocks(), async () => { calls += 1; return { text: "x", lang: "zh" }; }, { stop: () => calls >= 1 })).toEqual({ state: "stopped" });
});
