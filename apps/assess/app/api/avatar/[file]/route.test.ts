import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { getResultByInvite } from "../../../../server/store";
import { templateImagePath } from "../../../../server/avatar";
import { TINY_PNG } from "../../../../server/avatar/fake-provider";
import { storedResult } from "../../../../server/avatar/testing";
import { GET } from "./route";

vi.mock("../../../../server/store", () => ({ getResultByInvite: vi.fn(), setAvatarState: vi.fn(), avatarsDrawnFor: vi.fn(() => 0) }));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assess-route-"));
  vi.stubEnv("ASSESS_DATA_DIR", dir);
  vi.mocked(getResultByInvite).mockReset();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const get = (file: string, query = "") => GET(new Request(`http://127.0.0.1:3340/api/avatar/${file}${query}`), { params: Promise.resolve({ file }) });

test("a figure still drawing is served as its type's template, revalidated every time", async () => {
  vi.mocked(getResultByInvite).mockReturnValue(storedResult({ code: "SEMP", avatar: { state: "drawing", file: "" } }));
  const response = await get("inv_public_token_0001.png");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("image/png");
  expect(response.headers.get("cache-control")).toMatch(/max-age=0/);
  expect(Buffer.from(await response.arrayBuffer())).toEqual(fs.readFileSync(templateImagePath("SEMP")));
  expect(getResultByInvite).toHaveBeenCalledWith("inv_public_token_0001");
});

test("a ready figure is served from the data directory, and its versioned address may be cached", async () => {
  fs.mkdirSync(path.join(dir, "avatars"));
  fs.writeFileSync(path.join(dir, "avatars", "res_0001.png"), TINY_PNG);
  vi.mocked(getResultByInvite).mockReturnValue(storedResult({ avatar: { state: "ready", file: path.join("avatars", "res_0001.png") } }));
  const response = await get("inv_public_token_0001.png", "?v=123");
  expect(Buffer.from(await response.arrayBuffer())).toEqual(TINY_PNG);
  expect(response.headers.get("cache-control")).toMatch(/immutable/);
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
});

test("an unknown token, a malformed name or a path is a 404", async () => {
  vi.mocked(getResultByInvite).mockReturnValue(undefined);
  expect((await get("inv_unknown_token_9999.png")).status).toBe(404);
  expect((await get("..%2F..%2Fsecret.png")).status).toBe(404);
  expect((await get("inv_public_token_0001.jpg")).status).toBe(404);
  expect(getResultByInvite).toHaveBeenCalledTimes(1);
});
