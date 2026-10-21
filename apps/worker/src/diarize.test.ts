import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { SpeakerBook, enrolVoiceprint, labelledTurns, readVoiceprint, unit, voiceprintFailedFile, voiceprintFile, type Diarizer } from "./diarize";
import { transcribeBlocks } from "./sensevoice";
import { RATE, signal } from "./testing/audio";

let data: string;
beforeEach(() => { data = mkdtempSync(path.join(tmpdir(), "crossline-diarize-")); });
afterEach(() => rmSync(data, { recursive: true, force: true }));

// Three made-up voices, far apart, and a slightly different take on each.
const voice = (index: number, wobble = 0) => unit(Array.from({ length: 8 }, (_, i) => (i === index ? 1 : 0) + (i === (index + 1) % 8 ? wobble : 0)));

test("speakers are numbered in the order they first speak and matched across blocks; the voiceprint's owner is 本人", () => {
  const book = new SpeakerBook(voice(0));
  expect(book.label(voice(1))).toBe("说话人 1");
  expect(book.label(voice(2))).toBe("说话人 2");
  expect(book.label(voice(1, 0.3))).toBe("说话人 1");
  expect(book.label(voice(0, 0.2))).toBe("本人");
  expect(new SpeakerBook().label(voice(0))).toBe("说话人 1");
});

test("a block's local speakers are embedded once each from their own turns and labelled through the book", async () => {
  const embedded: number[] = [];
  const diarizer: Diarizer = {
    segments: async () => [{ start: 0, end: 4, speaker: 0 }, { start: 4, end: 9, speaker: 1 }, { start: 9, end: 9.1, speaker: 2 }, { start: 10, end: 12, speaker: 0 }],
    embed: async (samples) => { embedded.push(samples.length / RATE); return embedded.length === 1 ? voice(3) : voice(4); }
  };
  const turns = await labelledTurns(signal(12, [[0, 12]]), diarizer, new SpeakerBook());
  expect(turns.map((turn) => turn.speaker)).toEqual(["说话人 1", "说话人 2", "说话人 1"]);
  expect(embedded).toEqual([6, 5]);
});

test("a transcript names who spoke each line, with times mapped back from the speech alone to the recording", async () => {
  // Speech at 10–20 s and 40–50 s of a minute; the diarizer sees only those twenty seconds, with the speaker changing halfway.
  const diarizer: Diarizer = {
    segments: async (samples) => { expect(samples.length / RATE).toBeLessThan(30); return [{ start: 0, end: 10.5, speaker: 0 }, { start: 10.5, end: 20, speaker: 1 }]; },
    embed: async (samples) => samples.length / RATE > 10 ? voice(0) : voice(5)
  };
  async function* blocks() { yield signal(60, [[10, 20], [40, 50]]); }
  let said = 0;
  const result = await transcribeBlocks(blocks(), async () => ({ text: `第 ${++said} 句`, lang: "zh" }), { speakers: { diarizer, book: new SpeakerBook(voice(0)) } });
  if (result.state !== "transcribed") throw new Error(result.state);
  const lines = result.text.split("\n").slice(1);
  // The second speaker's turn runs past the first stretch of speech into the second: it is cut at the gap, each part at its own time.
  expect(lines).toEqual(["[00:09] 本人：第 1 句", "[00:20] 说话人 1：第 2 句", "[00:39] 说话人 1：第 3 句"]);
});

test("a voiceprint needs fifteen seconds of speech; only the vector is written", async () => {
  async function* short() { yield signal(30, [[5, 12]]); }
  expect(await enrolVoiceprint(data, "ws", short(), { embed: async () => voice(2) })).toMatchObject({ ok: false });
  expect(existsSync(voiceprintFailedFile(data, "ws"))).toBe(true);
  async function* long() { yield signal(90, [[5, 60]]); }
  expect(await enrolVoiceprint(data, "ws", long(), { embed: async () => voice(2) })).toMatchObject({ ok: true });
  expect(existsSync(voiceprintFailedFile(data, "ws"))).toBe(false);
  expect(Object.keys(JSON.parse(readFileSync(voiceprintFile(data, "ws"), "utf8"))).sort()).toEqual(["at", "seconds", "vector"]);
  expect(readVoiceprint(data, "ws")?.[2]).toBeCloseTo(1);
});
