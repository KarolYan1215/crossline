import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { DICTATION_SKILL, aliveFile, createDictationService, dictateSamples, inboxDir, outboxDir, pcmToSamples, rememberWordings, uploadDir } from "./dictation";
import { fakeRuntime } from "./testing/fake-runtime";
import { signal } from "./testing/audio";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(path.join(tmpdir(), "dictation-")); dirs.push(dir); return dir; };
const pcm = (samples: Float32Array) => {
  const out = Buffer.alloc(samples.length * 2);
  samples.forEach((value, index) => out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(value * 32767))), index * 2));
  return out;
};
const upload = (dataDir: string, workspaceId: string, bytes: Buffer, name = "clip-0001.pcm") => {
  mkdirSync(uploadDir(dataDir, workspaceId), { recursive: true });
  writeFileSync(path.join(uploadDir(dataDir, workspaceId), name), bytes);
  return name;
};

describe("dictateSamples", () => {
  it("recognises only the speech, in windows, and joins the text", async () => {
    const heard: number[] = [];
    const result = await dictateSamples(signal(30, [[1, 4], [10, 12]]), async (samples) => { heard.push(samples.length); return { text: heard.length === 1 ? "明天交 ECE" : "555 作业", lang: "zh" }; });
    expect(heard.length).toBeGreaterThan(0);
    expect(heard.reduce((sum, length) => sum + length, 0)).toBeLessThan(30 * 16_000 / 2);
    expect(result.language).toBe("zh");
    expect(result.text.startsWith("明天交 ECE")).toBe(true);
  });
  it("gives empty text for a clip with no speech, without asking the model", async () => {
    let asked = 0;
    const result = await dictateSamples(signal(3, []), async () => { asked += 1; return { text: "谢谢观看", lang: "zh" }; });
    expect(result).toEqual({ text: "", speechSeconds: 0 });
    expect(asked).toBe(0);
  });
  it("reads 16-bit PCM back to samples", () => {
    const samples = pcmToSamples(pcm(Float32Array.from([0, 0.5, -0.5])));
    expect(samples[1]).toBeCloseTo(0.5, 3);
    expect(samples[2]).toBeCloseTo(-0.5, 3);
  });
});

describe("dictation service", () => {
  it("transcribes a clip on this machine and deletes it as it is read", async () => {
    const dataDir = tempDir();
    const store = new CrosslineStore(":memory:");
    const service = createDictationService({ store, dataDir, cwd: "/repo", client: () => undefined, mode: "local",
      recogniser: async () => ({ text: "交作业", lang: "zh" }) });
    const name = upload(dataDir, "ws-1", pcm(signal(3, [[0.5, 2.5]])));
    const answer = await service.handle("POST", "/v1/voice/transcribe", "ws-1", { file: name });
    expect(answer).toEqual({ status: 200, body: { ok: true, text: "交作业", language: "zh" } });
    expect(readdirSync(uploadDir(dataDir, "ws-1"))).toEqual([]);
    expect((await service.handle("GET", "/v1/voice/status", "ws-1", undefined))?.body).toMatchObject({ mode: "local", server: "ready" });
  });

  it("refuses another workspace's file name and a path", async () => {
    const dataDir = tempDir();
    const service = createDictationService({ store: new CrosslineStore(":memory:"), dataDir, cwd: "/repo", client: () => undefined, mode: "local",
      recogniser: async () => ({ text: "x", lang: "zh" }) });
    upload(dataDir, "ws-1", pcm(signal(3, [[0.5, 2.5]])));
    expect((await service.handle("POST", "/v1/voice/transcribe", "ws-2", { file: "clip-0001.pcm" }))?.status).toBe(404);
    expect((await service.handle("POST", "/v1/voice/transcribe", "ws-1", { file: "../ws-1/clip-0001.pcm" }))?.status).toBe(400);
  });

  it("says the local model is missing until it is downloaded with consent", async () => {
    const dataDir = tempDir();
    const service = createDictationService({ store: new CrosslineStore(":memory:"), dataDir, cwd: "/repo", client: () => undefined, mode: "local",
      modelDir: path.join(dataDir, "models", "sensevoice") });
    expect((await service.handle("GET", "/v1/voice/status", "ws-1", undefined))?.body).toMatchObject({ server: "model_missing" });
    expect((await service.handle("POST", "/v1/voice/model", "ws-1", {}))?.status).toBe(400);
  });

  it("hands a clip to the server transcriber and returns its answer", async () => {
    const dataDir = tempDir();
    const service = createDictationService({ store: new CrosslineStore(":memory:"), dataDir, cwd: "/repo", client: () => undefined, mode: "server" });
    expect((await service.handle("GET", "/v1/voice/status", "ws-1", undefined))?.body).toMatchObject({ server: "unavailable" });
    mkdirSync(path.dirname(aliveFile(dataDir)), { recursive: true });
    writeFileSync(aliveFile(dataDir), "");
    const name = upload(dataDir, "ws-1", pcm(signal(2, [[0.2, 1.8]])));
    const transcriber = setInterval(() => {
      if (!existsSync(inboxDir(dataDir))) return;
      for (const file of readdirSync(inboxDir(dataDir)).filter((entry) => entry.endsWith(".pcm"))) {
        mkdirSync(outboxDir(dataDir), { recursive: true });
        writeFileSync(path.join(outboxDir(dataDir), file.replace(".pcm", ".json")), JSON.stringify({ text: "服务器听到的", language: "zh" }));
      }
    }, 20);
    try {
      const answer = await service.handle("POST", "/v1/voice/transcribe", "ws-1", { file: name });
      expect(answer).toEqual({ status: 200, body: { ok: true, text: "服务器听到的", language: "zh" } });
    } finally { clearInterval(transcriber); }
    expect(readdirSync(inboxDir(dataDir))).toEqual([]);
    expect(readdirSync(outboxDir(dataDir))).toEqual([]);
  });

  it("corrects against the person's names and keeps the raw text when the answer rewrites it", async () => {
    const store = new CrosslineStore(":memory:");
    rememberWordings(store, "ws-1", [{ heard: "cross line", meant: "Crossline" }]);
    const fixed = fakeRuntime([JSON.stringify({ text: "这周 Crossline 的语音输入要做完。" })], DICTATION_SKILL);
    const service = createDictationService({ store, dataDir: tempDir(), cwd: "/repo", client: () => fixed.rpc, mode: "local", recogniser: async () => ({ text: "", lang: "" }) });
    const answer = await service.handle("POST", "/v1/voice/correct", "ws-1", { raw: "这周 cross line 的语音输入要做完", language: "zh", field: { kind: "conversation" } });
    expect(answer?.body).toMatchObject({ ok: true, text: "这周 Crossline 的语音输入要做完。", count: 1 });
    expect(fixed.prompts().join("\n")).toContain("「cross line」 → 「Crossline」");

    const rewritten = fakeRuntime([JSON.stringify({ text: "本周需完成产品的全部语音功能开发与上线工作，并通知团队。" })], DICTATION_SKILL);
    const strict = createDictationService({ store, dataDir: tempDir(), cwd: "/repo", client: () => rewritten.rpc, mode: "local", recogniser: async () => ({ text: "", lang: "" }) });
    const kept = await strict.handle("POST", "/v1/voice/correct", "ws-1", { raw: "这周语音输入要做完", language: "zh" });
    expect(kept?.body).toMatchObject({ ok: true, text: "这周语音输入要做完", count: 0, kept: "raw" });
  });

  it("remembers wordings once per heard form, under its own scope", async () => {
    const store = new CrosslineStore(":memory:");
    const service = createDictationService({ store, dataDir: tempDir(), cwd: "/repo", client: () => undefined, mode: "local", recogniser: async () => ({ text: "", lang: "" }) });
    await service.handle("POST", "/v1/voice/lexicon", "ws-1", { edits: [{ heard: "王老", meant: "汪老" }] });
    await service.handle("POST", "/v1/voice/lexicon", "ws-1", { edits: [{ heard: "王老", meant: "黄老" }, { heard: "x".repeat(40), meant: "y" }] });
    const entries = store.listPreferences("ws-1").filter((entry) => entry.source === "dictation");
    expect(entries.map((entry) => [entry.scope, entry.text])).toEqual([["dictation", "「王老」 → 「黄老」"]]);
    expect(store.preferenceLines("ws-1", ["research"])).toEqual([]);
  });
});
