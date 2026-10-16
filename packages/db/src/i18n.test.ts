// db has no direct dependency on the catalogues: the English the worker and web register, loaded for this test.
import "../../i18n/src/catalog-worker";
import { expect, test } from "vitest";
import { CrosslineStore, accountLocale, interviewChecklistFor, lockInterviewLocale, writeLocale } from "./index";

const lines = [{ id: "research", label: "研究者", hard: false, goals: [] }];

test("the interview's completion list is in the interview's language, not the page's", () => {
  const store = new CrosslineStore(":memory:");
  const chinese = interviewChecklistFor(store, "w", lines, { unfiledFiles: 0, today: "2026-10-16" }).map((item) => item.label);
  // An interview started in English keeps English labels even after the interface goes back to Chinese.
  writeLocale(store, "w", "en");
  lockInterviewLocale(store, "w", "main");
  writeLocale(store, "w", "zh");
  const english = interviewChecklistFor(store, "w", lines, { unfiledFiles: 0, today: "2026-10-16" }).map((item) => item.label);
  expect(english).not.toEqual(chinese);
  expect(english.join(" ")).not.toMatch(/[一-鿿]{2}/.source.length ? /(?!研究者)[一-鿿]{3,}/ : /x/);
  // Asked for in a language, it is that language.
  expect(interviewChecklistFor(store, "w", lines, { unfiledFiles: 0, today: "2026-10-16", locale: "zh" }).map((item) => item.label)).toEqual(chinese);
  store.close();
});

test("an account's chosen language is found from its sign-in id; one with no choice has none", () => {
  const store = new CrosslineStore(":memory:");
  const { workspace } = store.resolvePrincipalWorkspace("auth-1", "ws");
  expect(accountLocale(store, "auth-1")).toBeUndefined();
  writeLocale(store, workspace.id, "en");
  expect(accountLocale(store, "auth-1")).toBe("en");
  expect(accountLocale(store, "nobody")).toBeUndefined();
  store.close();
});
