import { expect, test } from "vitest";
import { MENTION_AT } from "./composer";

test("@ opens the list after Chinese text, a space or the start, but not inside an email address", () => {
  const query = (text: string) => MENTION_AT.exec(text)?.[2];
  expect(query("看看@作业")).toBe("作业");
  expect(query("@ECE")).toBe("ECE");
  expect(query("关于 @hw3")).toBe("hw3");
  expect(query("把，@")).toBe("");
  expect(query("写信给 a@b")).toBeUndefined();
  expect(query("@ECE 555")).toBeUndefined();
});
