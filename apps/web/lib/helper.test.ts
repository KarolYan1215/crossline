import { afterEach, expect, test, vi } from "vitest";
import { CrosslineStore } from "@crossline/db";
vi.mock("server-only", () => ({}));
vi.mock("./runtime-status", () => ({ runtimeStatus: vi.fn(async () => undefined) }));
import { helperState } from "./helper";
import { TEST_CTX } from "./test-support";

afterEach(() => { globalThis.crosslineStore?.close(); globalThis.crosslineStore = undefined; });

test("the figure is the latest drawing, addressed by when it was drawn, so a new one is fetched once and never shown stale", async () => {
  const store = globalThis.crosslineStore = new CrosslineStore(":memory:");
  expect((await helperState(TEST_CTX)).avatar).toBeNull();
  store.setSetting(TEST_CTX.workspaceId, "portrait.images", JSON.stringify({ version: 4, images: { character: { file: "v4-character.png", at: "2026-10-12T10:00:00.000Z" } } }));
  const v4 = (await helperState(TEST_CTX)).avatar;
  store.setSetting(TEST_CTX.workspaceId, "portrait.images", JSON.stringify({ version: 5, images: { character: { file: "v5-character.png", at: "2026-10-14T19:17:09.347Z" } } }));
  const v5 = (await helperState(TEST_CTX)).avatar;
  expect(v5).toBe(`/api/portrait/image/character?v=${encodeURIComponent("2026-10-14T19:17:09.347Z")}`);
  expect(v5).not.toBe(v4);
});
