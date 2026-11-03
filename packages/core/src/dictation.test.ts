import { expect, test } from "vitest";
import { correctionCount, lexiconEdits, lexiconFromText, lexiconText, readVoicePreferences, speechLang, textHunks, dictationSimilarity,
  validateDictationCorrection } from "./dictation";

test("preferences default to on, auto language and correction", () => {
  expect(readVoicePreferences(undefined)).toEqual({ enabled: true, language: "auto", correct: true });
  expect(readVoicePreferences("{\"language\":\"yue\",\"correct\":false}")).toEqual({ enabled: true, language: "yue", correct: false });
  expect(readVoicePreferences("{\"language\":\"fr\"}").language).toBe("auto");
  expect(readVoicePreferences("not json").enabled).toBe(true);
});

test("the browser's language follows the interface unless set", () => {
  expect(speechLang({ language: "auto" }, "zh")).toBe("zh-CN");
  expect(speechLang({ language: "auto" }, "en")).toBe("en-US");
  expect(speechLang({ language: "en" }, "zh")).toBe("en-US");
  expect(speechLang({ language: "yue" }, "zh")).toBe("yue-Hant-HK");
  expect(speechLang({ language: "yue" }, "zh", true)).toBe("zh-HK");
});

test("hunks name each changed span", () => {
  expect(textHunks("完成 ECE 五五五作业", "完成 ECE 555 作业")).toEqual([{ from: "五五五", to: "555 " }]);
  expect(textHunks("abc", "abc")).toEqual([]);
  expect(textHunks("嗯那个明天交作业", "明天交作业")).toEqual([{ from: "嗯那个", to: "" }]);
});

test("a correction that fixes words is kept; a rewrite is refused", () => {
  const raw = "明天下午把一一五五五的作业三交了然后跟导师约个时间";
  expect(validateDictationCorrection(raw, { text: "明天下午把 ECE 555 的作业 3 交了，然后跟导师约个时间。" }).text).toContain("ECE 555");
  expect(() => validateDictationCorrection(raw, { text: "提交作业并预约导师会面" })).toThrow(/DICTATION_REWRITTEN/);
  expect(() => validateDictationCorrection(raw, { text: " " })).toThrow(/DICTATION_CORRECTION_EMPTY/);
  // A short clip may gain its punctuation and a fixed name.
  expect(validateDictationCorrection("交作业三", { text: "交作业 3。" }).text).toBe("交作业 3。");
});

test("the count leaves punctuation and spacing out", () => {
  expect(correctionCount("明天交作业三然后开会", "明天交作业 3，然后开会。")).toBe(1);
  expect(correctionCount("一样", "一样。")).toBe(0);
  expect(dictationSimilarity("a b", "a  b")).toBe(1);
});

test("an edit of one word teaches it; a rewrite teaches nothing", () => {
  expect(lexiconEdits("下周给王老师发 cross line 的进度", "下周给王老师发 Crossline 的进度")).toEqual([{ heard: "cross line", meant: "Crossline" }]);
  expect(lexiconEdits("我想去吃饭", "今天开组会讨论论文")).toEqual([]);
  expect(lexiconEdits("交作业", "交作业了")).toEqual([]);
  const edit = { heard: "cross line", meant: "Crossline" };
  expect(lexiconFromText(lexiconText(edit))).toEqual(edit);
});

test("a one-character Chinese fix takes its neighbour", () => {
  expect(lexiconEdits("明天找王老师签字", "明天找汪老师签字")).toEqual([{ heard: "王老", meant: "汪老" }]);
  expect(lexiconEdits("提交 ECE 五四八 作业", "提交 ECE 548 作业")).toEqual([{ heard: "五四八", meant: "548" }]);
});
