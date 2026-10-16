import { mkdtempSync, rmSync } from "node:fs";
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

test("an account has at most its own number of figures drawn on the server's key, and keeps the last one past it", async () => {
  expect(imageDrawsPerAccount({})).toBe(3);
  expect(imageDrawsPerAccount({ CROSSLINE_IMAGE_PER_ACCOUNT: "5" })).toBe(5);
  vi.stubEnv("CROSSLINE_IMAGE_PER_ACCOUNT", "2");
  dir = mkdtempSync(join(tmpdir(), "portrait-"));
  const store = new CrosslineStore(":memory:");
  const ws = store.createPrincipalWithWorkspace("u", "w").workspace.id;
  store.setSetting(ws, "portrait.report", JSON.stringify({ version: 1, report: {} }));
  const generate = vi.fn(async () => PNG);
  const illustrate = createPortraitIllustrator(store, ws, dir, dir, () => undefined, () => ({ id: "ark", model: "m", generate }));
  expect((await illustrate()).drawn).toEqual(["character"]);
  expect((await illustrate()).drawn).toEqual(["character"]);
  const third = await illustrate();
  expect(third).toEqual({ drawn: [], failed: [] });
  expect(generate).toHaveBeenCalledTimes(2);
  expect(JSON.parse(store.getSetting(ws, PORTRAIT_IMAGE_DRAWS)!).count).toBe(2);
  // The figure already drawn is still what the page shows.
  expect(JSON.parse(store.getSetting(ws, PORTRAIT_IMAGES)!).images.character.file).toBe("v1-character.png");
  store.close();
});
