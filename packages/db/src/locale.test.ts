import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "./index";
import { chosenLocale, interviewLocale, lockInterviewLocale, readLocale, writeLocale } from "./locale";

let store: CrosslineStore;
const ws = "workspace-a";
beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

test("the workspace's language is Chinese until chosen, and a choice is kept", () => {
  expect(readLocale(store, ws)).toBe("zh");
  expect(chosenLocale(store, ws)).toBeUndefined();
  writeLocale(store, ws, "en");
  expect(readLocale(store, ws)).toBe("en");
  expect(chosenLocale(store, ws)).toBe("en");
});

test("the interview keeps the language it started in, whatever the interface is switched to", () => {
  expect(interviewLocale(store, ws)).toBeUndefined();
  writeLocale(store, ws, "en");
  expect(lockInterviewLocale(store, ws, "s1")).toBe("en");
  writeLocale(store, ws, "zh");
  expect(lockInterviewLocale(store, ws, "s1")).toBe("en");
  expect(interviewLocale(store, ws)).toBe("en");
  // A line's own interview started later locks its own language, and does not move the main one the portrait follows.
  expect(lockInterviewLocale(store, ws, "line-research")).toBe("zh");
  expect(interviewLocale(store, ws)).toBe("en");
});
