import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
import { addLine, identityLines, lineLabels, updateLine } from "./lines";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("adding a line keeps the account's existing lines, gives it a free colour, and archiving hides it but keeps its name", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect(identityLines(TEST_CTX).map((line) => line.id)).toEqual(["research", "startup", "media", "investment"]);
  const added = addLine(TEST_CTX, { label: "Music", goal: "成为能独立发行作品的创作者" });
  expect(added).toEqual({ ok: true, id: "line-music" });
  expect(identityLines(TEST_CTX).at(-1)).toMatchObject({ id: "line-music", label: "Music", color: "teal", goal: "成为能独立发行作品的创作者" });
  expect(addLine(TEST_CTX, { label: "Music", goal: "" })).toEqual({ ok: false, code: "LINE_LABEL_TAKEN" });
  expect(updateLine(TEST_CTX, "research", { goal: "成为能独立立项的研究者" })).toEqual({ ok: true });
  expect(identityLines(TEST_CTX)[0]).toMatchObject({ id: "research", goal: "成为能独立立项的研究者" });
  expect(updateLine(TEST_CTX, "line-music", { archived: true })).toEqual({ ok: true });
  expect(identityLines(TEST_CTX).map((line) => line.id)).not.toContain("line-music");
  expect(lineLabels(TEST_CTX)["line-music"]).toBe("Music");
});
