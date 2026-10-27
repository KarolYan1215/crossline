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

test("lite edition: the opening card writes domain lines with their fixed ids and colours, and a second line of a domain is refused", async () => {
  const { setupLines } = await import("./lines");
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  const setup = setupLines(TEST_CTX, [{ label: "上班", ranked: true, hard: true }, { label: "", ranked: false, hard: false, domain: "wellness" },
    { label: "理财者", ranked: false, hard: false, domain: "wealth" }]);
  expect(setup).toEqual({ ok: true, ids: ["line-x", "line-wellness", "line-wealth"] });
  expect(identityLines(TEST_CTX).map((line) => [line.id, line.label, line.color, line.domain ?? null])).toEqual([
    ["line-x", "上班", "research", null], ["line-wellness", "健康管理者", "olive", "wellness"], ["line-wealth", "理财者", "teal", "wealth"]]);
  expect(addLine(TEST_CTX, { label: "投资者", goal: "", domain: "wealth" })).toEqual({ ok: false, code: "LINE_DOMAIN_TAKEN", lineId: "line-wealth" });
  expect(setupLines(TEST_CTX, [{ label: "A", ranked: false, hard: false, domain: "wealth" }, { label: "B", ranked: false, hard: false, domain: "wealth" }]))
    .toEqual({ ok: false, code: "LINE_DOMAIN_TAKEN" });
});

test("a full-edition account tags its investment line with the wealth domain instead of adding a second one", () => {
  globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect(updateLine(TEST_CTX, "investment", { domain: "wealth" })).toEqual({ ok: true });
  expect(identityLines(TEST_CTX).find((line) => line.id === "investment")).toMatchObject({ domain: "wealth", noTradeCalls: true });
  expect(addLine(TEST_CTX, { label: "", goal: "", domain: "wealth" })).toEqual({ ok: false, code: "LINE_DOMAIN_TAKEN", lineId: "investment" });
  // Adding health to the full edition is one more line, with the domain's own id and the noun as its name.
  expect(addLine(TEST_CTX, { label: "", goal: "", domain: "wellness" })).toEqual({ ok: true, id: "line-wellness" });
  expect(identityLines(TEST_CTX).at(-1)).toMatchObject({ label: "健康管理者", domain: "wellness" });
  // Restoring an archived wealth line while another holds the domain is refused; removing the domain frees it.
  expect(updateLine(TEST_CTX, "investment", { archived: true })).toEqual({ ok: true });
  expect(addLine(TEST_CTX, { label: "理财者", goal: "", domain: "wealth" })).toEqual({ ok: true, id: "line-wealth" });
  expect(updateLine(TEST_CTX, "investment", { archived: false })).toEqual({ ok: false, code: "LINE_DOMAIN_TAKEN", lineId: "line-wealth" });
  expect(updateLine(TEST_CTX, "investment", { archived: false, domain: null })).toEqual({ ok: true });
});
