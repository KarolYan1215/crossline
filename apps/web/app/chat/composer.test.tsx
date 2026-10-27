import { expect, test } from "vitest";
import { hintFor, MENTION_AT } from "./composer";

test("on a phone the box shows its short hint, and the long one stays everywhere else (2026-10-21: three lines at 375px)", () => {
  const long = "任务、改期、回答待决、撤销、日程、问题……一句话即可";
  expect(hintFor(long, "一句话：任务、改期、问题……", true)).toBe("一句话：任务、改期、问题……");
  expect(hintFor(long, "一句话：任务、改期、问题……", false)).toBe(long);
  expect(hintFor(long, undefined, true)).toBe(long);
});

test("@ opens the list after Chinese text, a space or the start, but not inside an email address", () => {
  const query = (text: string) => MENTION_AT.exec(text)?.[2];
  expect(query("看看@作业")).toBe("作业");
  expect(query("@ECE")).toBe("ECE");
  expect(query("关于 @hw3")).toBe("hw3");
  expect(query("把，@")).toBe("");
  expect(query("写信给 a@b")).toBeUndefined();
  expect(query("@ECE 555")).toBeUndefined();
});
