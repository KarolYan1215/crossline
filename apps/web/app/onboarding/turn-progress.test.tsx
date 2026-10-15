import { expect, test } from "vitest";
import type { OnboardingProgress } from "@crossline/core";
import { progressHeadline } from "./turn-progress";

const at = (over: Partial<OnboardingProgress>): OnboardingProgress => ({ sessionId: "s", startedAt: "", updatedAt: "", phase: "thinking", files: [],
  facts: 0, dates: 0, questions: 0, reply: "", repairs: 0, stalls: 0, ...over });

test("the wait says what the turn is doing: reading named files, writing, checking, or fixing what the check sent back", () => {
  expect(progressHeadline(null)).toBe("正在准备这一轮…");
  expect(progressHeadline(at({ files: ["课程大纲.pdf", "简历.docx", "课表.png"] }))).toBe("正在读 3 个文件：课程大纲.pdf、简历.docx 等");
  expect(progressHeadline(at({}))).toBe("正在想下一组问题");
  expect(progressHeadline(at({ phase: "writing" }))).toBe("正在写回答");
  expect(progressHeadline(at({ phase: "checking" }))).toBe("写完了，正在核对引文和日期");
  expect(progressHeadline(at({ phase: "writing", repairs: 1 }))).toBe("第一次的回答有一处没过核对，正在修正（第 1 次）");
  expect(progressHeadline(at({ stalls: 1 }))).toBe("上一次没有回音，已重新发送");
});
