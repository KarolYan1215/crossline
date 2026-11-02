import { describe, expect, it } from "vitest";
import { chooseEngine, clock, insertDictation, isIosStandalone, isSafari, mixDown, spanNow, toPcm16 } from "./voice-model";

const facts = { hasSpeechRecognition: true, iosStandalone: false, online: true, browserBroken: false, server: "ready" as const, mode: "server" as const };

describe("voice engine", () => {
  it("takes the browser first and Crossline's own where the browser cannot", () => {
    expect(chooseEngine(facts)).toBe("browser");
    expect(chooseEngine({ ...facts, iosStandalone: true })).toBe("server");
    expect(chooseEngine({ ...facts, browserBroken: true })).toBe("server");
    expect(chooseEngine({ ...facts, hasSpeechRecognition: false, server: "unavailable" })).toBe("none");
    expect(chooseEngine({ ...facts, hasSpeechRecognition: false, server: "model_missing", mode: "local" })).toBe("model_needed");
    expect(chooseEngine({ ...facts, hasSpeechRecognition: false, server: "model_missing", mode: "server" })).toBe("none");
  });
  it("knows the iPhone home-screen app and Safari", () => {
    expect(isIosStandalone({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", standalone: true }, false)).toBe(true);
    expect(isIosStandalone({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)", standalone: false }, false)).toBe(false);
    expect(isIosStandalone({ userAgent: "Mozilla/5.0 (Windows NT 10.0)" }, true)).toBe(false);
    expect(isSafari("Mozilla/5.0 (Macintosh) AppleWebKit/605 Version/18.0 Safari/605")).toBe(true);
    expect(isSafari("Mozilla/5.0 (Windows) Chrome/140 Safari/537")).toBe(false);
  });
});

describe("dictated text in the box", () => {
  it("goes where the caret was, spaced only between Latin words", () => {
    expect(insertDictation("明天", 2, 2, "交作业")).toEqual({ value: "明天交作业", at: 2, inserted: "交作业" });
    expect(insertDictation("finish the", 10, 10, "report")).toEqual({ value: "finish the report", at: 11, inserted: "report" });
    expect(insertDictation("交 ECE  作业", 6, 6, "555").value).toBe("交 ECE 555 作业");
    expect(insertDictation("abc", 3, 3, "一二三四", 5).value).toBe("abc一二");
  });
  it("is followed while what is around it stays, and let go once it changes", () => {
    const span = { prefix: "明天", suffix: "。", text: "交作业" };
    expect(spanNow(span, "明天交 ECE 作业。")).toBe("交 ECE 作业");
    expect(spanNow(span, "后天交作业。")).toBeUndefined();
    expect(spanNow(span, "")).toBeUndefined();
  });
  it("formats the timer", () => { expect(clock(0)).toBe("0:00"); expect(clock(185)).toBe("3:05"); });
});

describe("audio for Crossline's engine", () => {
  it("resamples to 16 kHz 16-bit PCM and mixes channels", () => {
    const pcm = toPcm16(new Float32Array(48_000).fill(0.5), 48_000);
    expect(pcm.length).toBe(32_000);
    expect(new DataView(pcm.buffer).getInt16(0, true)).toBe(16384);
    expect(Array.from(mixDown([Float32Array.from([1, 0]), Float32Array.from([0, 0])]))).toEqual([0.5, 0]);
  });
});
