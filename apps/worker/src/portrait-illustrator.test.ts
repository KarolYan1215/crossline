import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { createPortraitIllustrator, imageDrawsPerAccount, PORTRAIT_IMAGE_DRAWS, PORTRAIT_IMAGES } from "./portrait-illustrator";

// The account runs on another model, so its figure is drawn on the server's image key; the prompt itself is not what is tested here.
vi.mock("@crossline/codex", async (original) => ({ ...(await original<typeof import("@crossline/codex")>()), currentRoute: () => ({ via: "provider" }) }));
vi.mock("@crossline/core", async (original) => ({ ...(await original<typeof import("@crossline/core")>()), characterPrompt: () => "a figure" }));

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
let dir: string | undefined;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); vi.unstubAllEnvs(); });

function setup() {
  dir = mkdtempSync(join(tmpdir(), "portrait-"));
  const store = new CrosslineStore(":memory:");
  const ws = store.createPrincipalWithWorkspace("u", "w").workspace.id;
  store.setSetting(ws, "portrait.report", JSON.stringify({ version: 1, report: {} }));
  return { store, ws, folder: join(dir, "portrait", ws.replace(/[^a-zA-Z0-9_-]/g, "_")) };
}
const figureOf = (store: CrosslineStore, ws: string) => JSON.parse(store.getSetting(ws, PORTRAIT_IMAGES)!).images.character as { file: string; basis?: string };

test("an account has at most its own number of figures drawn on the server's key, and keeps the last one past it", async () => {
  expect(imageDrawsPerAccount({})).toBe(3);
  expect(imageDrawsPerAccount({ CROSSLINE_IMAGE_PER_ACCOUNT: "5" })).toBe(5);
  vi.stubEnv("CROSSLINE_IMAGE_PER_ACCOUNT", "2");
  const { store, ws } = setup();
  const generate = vi.fn(async () => PNG);
  const illustrate = createPortraitIllustrator(store, ws, dir!, dir!, () => undefined, () => ({ id: "ark", model: "m", generate }));
  expect((await illustrate()).drawn).toEqual(["character"]);
  expect((await illustrate({ redraw: true })).drawn).toEqual(["character"]);
  const third = await illustrate({ redraw: true });
  expect(third).toEqual({ drawn: [], failed: [] });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(JSON.parse(store.getSetting(ws, PORTRAIT_IMAGE_DRAWS)!).count).toBe(2);
  // The figure already drawn is still what the page shows; the second drawing of one version did not write over the first.
  expect(figureOf(store, ws).file).toBe("v1r2-character.png");
  store.close();
});

test("a rewritten report keeps the figure; the person's new description of how they look, or a failed drawing, are handled without losing one", async () => {
  const { store, ws, folder } = setup();
  const generate = vi.fn(async () => PNG);
  const illustrate = createPortraitIllustrator(store, ws, dir!, dir!, () => undefined, () => ({ id: "ark", model: "m", generate }));
  store.upsertProfileFact({ workspaceId: ws, identityId: "person", projectId: "", slot: "hairstyle", value: "狼尾长发。", status: "confirmed",
    sourceRef: "reply-21", sourceQuote: "狼尾长发", updatedAt: "2026-10-14T07:16:40.354Z" });
  expect((await illustrate()).drawn).toEqual(["character"]);
  expect(figureOf(store, ws)).toMatchObject({ file: "v1-character.png", basis: "hairstyle=狼尾长发。" });
  // The report is rewritten for a new schema (version 2): the figure stays, nothing is drawn or counted.
  store.setSetting(ws, "portrait.report", JSON.stringify({ version: 2, report: {} }));
  expect(await illustrate()).toEqual({ drawn: [], failed: [], kept: true });
  expect(generate).toHaveBeenCalledTimes(1);
  expect(figureOf(store, ws).file).toBe("v1-character.png");
  // The person says how they look differently: a new figure, the old file kept.
  store.upsertProfileFact({ workspaceId: ws, identityId: "person", projectId: "", slot: "clothing_preference", value: "全黑。", status: "confirmed",
    sourceRef: "reply-30", sourceQuote: "all black", updatedAt: "2026-10-15T07:20:03.071Z" });
  expect((await illustrate()).drawn).toEqual(["character"]);
  expect(figureOf(store, ws).file).toBe("v2-character.png");
  expect(readdirSync(folder).sort()).toEqual(["v1-character.png", "v2-character.png"]);
  // A drawing the person asked for that fails leaves the figure there was.
  generate.mockRejectedValueOnce(new Error("upstream"));
  expect((await illustrate({ redraw: true })).failed).toEqual(["character"]);
  expect(figureOf(store, ws).file).toBe("v2-character.png");
  expect(existsSync(join(folder, "v2r2-character.png"))).toBe(false);
  store.close();
});

test("a figure drawn before what it was drawn from was recorded is kept unless an appearance fact changed after it", async () => {
  const { store, ws } = setup();
  const generate = vi.fn(async () => PNG);
  const illustrate = createPortraitIllustrator(store, ws, dir!, dir!, () => undefined, () => ({ id: "ark", model: "m", generate }));
  store.setSetting(ws, PORTRAIT_IMAGES, JSON.stringify({ version: 1, images: { character: { file: "v1-character.png", at: "2026-10-14T19:17:09.347Z" } } }));
  store.upsertProfileFact({ workspaceId: ws, identityId: "person", projectId: "", slot: "gender", value: "男。", status: "confirmed",
    sourceRef: "reply-21", sourceQuote: "男", updatedAt: "2026-10-14T07:16:40.354Z" });
  expect((await illustrate()).kept).toBe(true);
  store.upsertProfileFact({ workspaceId: ws, identityId: "person", projectId: "", slot: "appearance", value: "狼尾长发男性，全黑穿搭。", status: "confirmed",
    sourceRef: "reply-30", sourceQuote: "狼尾长发男", updatedAt: "2026-10-15T07:20:03.071Z" });
  expect((await illustrate()).drawn).toEqual(["character"]);
  store.close();
});
