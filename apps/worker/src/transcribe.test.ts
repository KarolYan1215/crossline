import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { MAX_SECONDS, createTranscriber, formatTranscript, toMono16k, type TranscriptionEngine } from "./transcribe";

let dir: string;
beforeEach(() => { dir = mkdtempSync(path.join(os.tmpdir(), "crossline-whisper-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeEngine(over: Partial<TranscriptionEngine> = {}) {
  let ready = false;
  const calls = { download: 0, recognise: 0 };
  const engine: TranscriptionEngine = {
    modelReady: async () => ready,
    download: async (onProgress) => { calls.download += 1; onProgress(0.5); onProgress(1); ready = true; },
    recognise: async () => { calls.recognise += 1; return { text: "你好 world", chunks: [{ start: 0, end: 4, text: " 你好 " }, { start: 65, end: 70, text: "world" }] }; },
    ...over
  };
  return { engine, calls };
}
const seconds = (n: number, rate = 16_000) => ({ sampleRate: rate, channels: [new Float32Array(n * rate).fill(0.1)] });

test("nothing is downloaded until the person asks, and the status says what would be fetched", async () => {
  const { engine, calls } = fakeEngine();
  const transcriber = createTranscriber({ engine, decode: async () => seconds(5), modelsDir: dir });
  expect(await transcriber.status()).toMatchObject({ state: "needs_download", source: expect.stringContaining("huggingface.co"), approxMegabytes: expect.any(Number) });
  expect(await transcriber.transcribe(new Uint8Array(4), "a.mp3")).toMatchObject({ state: "needs_download" });
  expect(calls.download).toBe(0);
});

test("after a download the model is remembered across restarts, and recording works offline", async () => {
  const { engine, calls } = fakeEngine();
  const first = createTranscriber({ engine, decode: async () => seconds(5), modelsDir: dir });
  expect(await first.download()).toEqual({ state: "ready" });
  expect(calls.download).toBe(1);
  // A new transcriber on the same directory (a restart) does not ask again.
  const second = createTranscriber({ engine, decode: async () => seconds(5), modelsDir: dir });
  expect(await second.status()).toEqual({ state: "ready" });
  const result = await second.transcribe(new Uint8Array(4), "a.mp3");
  expect(result).toMatchObject({ state: "transcribed", seconds: 5, text: "[00:00] 你好\n[01:05] world" });
});

test("a failed download is reported and leaves the person able to try again", async () => {
  const { engine } = fakeEngine({ download: async () => { throw new Error("network down"); } });
  const transcriber = createTranscriber({ engine, decode: async () => seconds(5), modelsDir: dir });
  expect(await transcriber.download()).toMatchObject({ state: "unavailable", code: "MODEL_DOWNLOAD_FAILED", message: expect.stringContaining("network down") });
  expect(await transcriber.status()).toMatchObject({ state: "needs_download" });
});

test("a recording that cannot be read, is empty, or is too long is refused with a reason", async () => {
  const { engine, calls } = fakeEngine();
  await createTranscriber({ engine, decode: async () => seconds(5), modelsDir: dir }).download();
  const run = (decode: () => Promise<ReturnType<typeof seconds>>) => createTranscriber({ engine, decode, modelsDir: dir }).transcribe(new Uint8Array(4), "a.m4a");
  expect(await run(async () => { throw new Error("bad codec"); })).toMatchObject({ state: "failed", code: "AUDIO_DECODE_FAILED" });
  expect(await run(async () => seconds(0))).toMatchObject({ state: "failed", code: "AUDIO_EMPTY" });
  expect(await run(async () => seconds(MAX_SECONDS + 10, 8_000))).toMatchObject({ state: "failed", code: "AUDIO_TOO_LONG" });
  expect(calls.recognise).toBe(0);
  // The too-long case allocates three hours of 8 kHz samples (~345 MB), close to five seconds on its own.
}, 30_000);

test("a recogniser that finds no words, or fails, is reported rather than stored as an empty transcript", async () => {
  const empty = fakeEngine({ recognise: async () => ({ text: "  ", chunks: [] }) });
  await createTranscriber({ engine: empty.engine, decode: async () => seconds(5), modelsDir: dir }).download();
  expect(await createTranscriber({ engine: empty.engine, decode: async () => seconds(5), modelsDir: dir }).transcribe(new Uint8Array(4), "a.mp3"))
    .toMatchObject({ state: "failed", code: "TRANSCRIPT_EMPTY" });
  const broken = fakeEngine({ recognise: async () => { throw new Error("out of memory"); } });
  await createTranscriber({ engine: broken.engine, decode: async () => seconds(5), modelsDir: dir }).download();
  expect(await createTranscriber({ engine: broken.engine, decode: async () => seconds(5), modelsDir: dir }).transcribe(new Uint8Array(4), "a.mp3"))
    .toMatchObject({ state: "failed", code: "TRANSCRIPTION_FAILED" });
});

test("audio is averaged to mono and resampled to 16 kHz", () => {
  const stereo = { sampleRate: 48_000, channels: [new Float32Array(48_000).fill(0.2), new Float32Array(48_000).fill(0.4)] };
  const out = toMono16k(stereo);
  expect(out.length).toBe(16_000);
  expect(out[100]).toBeCloseTo(0.3, 5);
  expect(toMono16k(seconds(2)).length).toBe(32_000);
});

test("a transcript puts a start time on every stretch of speech", () => {
  expect(formatTranscript([{ start: 3725, end: 3730, text: "late" }, { start: 0, end: 1, text: " " }], "")).toBe("[1:02:05] late");
  expect(formatTranscript([], "  just text  ")).toBe("just text");
});

test("the transcript says which language was heard, and whether that was the person's choice or a guess", async () => {
  const heard: Array<string | undefined> = [];
  const { engine } = fakeEngine({ recognise: async (_samples, language) => { heard.push(language); return { text: "你好", chunks: [{ start: 0, end: 4, text: "你好" }], language: language ?? "zh" }; } });
  const transcriber = createTranscriber({ engine, decode: async () => seconds(5), modelsDir: dir });
  await transcriber.download();

  const auto = await transcriber.transcribe(new Uint8Array(4), "a.mp3");
  expect(auto).toMatchObject({ state: "transcribed" });
  expect(auto.text.startsWith("[语言：中文，自动识别]\n[00:00] 你好")).toBe(true);

  const chosen = await transcriber.transcribe(new Uint8Array(4), "a.mp3", "en");
  expect(chosen.text.startsWith("[语言：English]\n")).toBe(true);
  // Left unset, the engine is free to listen and decide; set, it is told.
  expect(heard).toEqual([undefined, "en"]);
});

test("Chinese is converted to simplified characters, other languages are left exactly as heard", async () => {
  const make = (language: string, text: string) => fakeEngine({ recognise: async () => ({ text, chunks: [{ start: 0, end: 3, text }], language }) });
  const seen: string[] = [];
  const simplify = async (text: string) => { seen.push(text); return text.replace("週", "周"); };
  const zh = make("zh", "下週一考試");
  const chinese = createTranscriber({ engine: zh.engine, decode: async () => seconds(5), modelsDir: dir, simplify });
  await chinese.download();
  expect((await chinese.transcribe(new Uint8Array(4), "a.mp3")).text).toContain("下周一考試");

  const en = make("en", "see you next 週");
  const english = createTranscriber({ engine: en.engine, decode: async () => seconds(5), modelsDir: dir, simplify });
  await english.download();
  expect((await english.transcribe(new Uint8Array(4), "a.mp3")).text).toContain("next 週");
  expect(seen).toHaveLength(1);
});

test("the real converter turns the traditional characters Whisper wrote into simplified ones, and leaves the words alone", async () => {
  const { simplifyChinese } = await import("./transcribe");
  expect(await simplifyChinese("下週一的七中考試在教學樓108教室,請帶一張小抄。")).toBe("下周一的七中考试在教学楼108教室,请带一张小抄。");
});
