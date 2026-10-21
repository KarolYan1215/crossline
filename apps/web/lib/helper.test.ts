import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./runtime-status", () => ({ runtimeStatus: vi.fn(async () => undefined) }));
import { helperState } from "./helper";
import { addFigure, chooseFigure, figureFolder, listFigures } from "./figures";
import { undoOp } from "./undo";
import { TEST_CTX } from "./test-support";

let dir: string | undefined;
afterEach(() => {
  globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined;
  vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPEG = Buffer.from("ffd8ffe000104a464946", "hex");

test("the figure is the latest drawing, addressed by file and when it was drawn, so a new one is fetched once and never shown stale", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect((await helperState(TEST_CTX)).avatar).toBeNull();
  store.setSetting(TEST_CTX.workspaceId, "portrait.images", JSON.stringify({ version: 4, images: { character: { file: "v4-character.png", at: "2026-10-12T10:00:00.000Z" } } }));
  const v4 = (await helperState(TEST_CTX)).avatar;
  store.setSetting(TEST_CTX.workspaceId, "portrait.images", JSON.stringify({ version: 5, images: { character: { file: "v5-character.png", at: "2026-10-14T19:17:09.347Z" } } }));
  const v5 = (await helperState(TEST_CTX)).avatar;
  expect(v5).toBe(`/api/portrait/image/character?file=v5-character.png&v=${encodeURIComponent("2026-10-14T19:17:09.347Z")}`);
  expect(v5).not.toBe(v4);
});

test("the person picks any figure drawn before, or adds one, as the 小帮手; the choice outlives new drawings and is undoable", async () => {
  dir = mkdtempSync(path.join(tmpdir(), "figures-"));
  vi.stubEnv("CROSSLINE_DATA_DIR", dir);
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  const folder = figureFolder(TEST_CTX.workspaceId);
  mkdirSync(folder, { recursive: true });
  for (const file of ["v5-character.png", "v6-character.png", "v2-cover.png"]) writeFileSync(path.join(folder, file), PNG);
  store.setSetting(TEST_CTX.workspaceId, "portrait.images", JSON.stringify({ version: 6, images: { character: { file: "v6-character.png", at: "2026-10-20T22:02:39Z" } } }));
  expect(listFigures(TEST_CTX).map((figure) => figure.file).sort()).toEqual(["v5-character.png", "v6-character.png"]);

  // Not a figure file, or not there: refused, nothing changes.
  expect((await chooseFigure(TEST_CTX, "../crossline.db")).code).toBe("FIGURE_NOT_FOUND");
  expect((await chooseFigure(TEST_CTX, "v9-character.png")).code).toBe("FIGURE_NOT_FOUND");

  const chosen = await chooseFigure(TEST_CTX, "v5-character.png");
  expect(chosen.ok).toBe(true);
  expect((await helperState(TEST_CTX)).avatar).toContain("file=v5-character.png");
  // A later drawing does not take the place of the person's choice.
  writeFileSync(path.join(folder, "v7-character.png"), PNG);
  store.setSetting(TEST_CTX.workspaceId, "portrait.images", JSON.stringify({ version: 7, images: { character: { file: "v7-character.png", at: "2026-10-22T00:00:00Z" } } }));
  expect((await helperState(TEST_CTX)).avatar).toContain("file=v5-character.png");
  expect(listFigures(TEST_CTX).find((figure) => figure.current)?.file).toBe("v5-character.png");
  expect(listFigures(TEST_CTX).find((figure) => figure.latest)?.file).toBe("v7-character.png");
  // Undo goes back to the latest drawing.
  expect(undoOp(TEST_CTX, chosen.op!.id).ok).toBe(true);
  expect((await helperState(TEST_CTX)).avatar).toContain("file=v7-character.png");

  // A picture the person adds: anything but an image is refused; an image is kept beside the drawn ones, picked at once.
  expect((await addFigure(TEST_CTX, new Uint8Array(Buffer.from("<html>")))).code).toBe("FIGURE_NOT_AN_IMAGE");
  const added = await addFigure(TEST_CTX, new Uint8Array(JPEG));
  expect(added).toMatchObject({ ok: true, file: "u1-character.png" });
  expect((await helperState(TEST_CTX)).avatar).toContain("file=u1-character.png");
  // Back to the latest; nothing was deleted on the way.
  expect((await chooseFigure(TEST_CTX, null)).ok).toBe(true);
  expect((await helperState(TEST_CTX)).avatar).toContain("file=v7-character.png");
  expect(readdirSync(folder).sort()).toEqual(["u1-character.png", "v2-cover.png", "v5-character.png", "v6-character.png", "v7-character.png"]);
});
