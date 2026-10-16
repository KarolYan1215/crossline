import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { avatarsDrawnFor, setAvatarState } from "../store";
import { budgetDay, budgetFile, spentToday, takeSlot } from "./budget";
import { FakeImageProvider, TINY_PNG } from "./fake-provider";
import { avatarImagePath, avatarQueueIdle, avatarStatus, configureAvatarPipeline, enqueueAvatar, templateImagePath } from "./index";
import { ProviderError, downloadImage, providerFromEnv, providerSummary } from "./provider";
import { storedResult } from "./testing";
import { templateVariant } from "./templates";

vi.mock("../store", () => ({ setAvatarState: vi.fn(), avatarsDrawnFor: vi.fn(() => 0) }));

const states = () => vi.mocked(setAvatarState).mock.calls.map((call) => call[1]);
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assess-avatar-"));
  vi.stubEnv("ASSESS_DATA_DIR", dir);
  vi.stubEnv("ASSESS_IMAGE_DAILY_LIMIT", "");
  vi.mocked(setAvatarState).mockClear();
  vi.mocked(avatarsDrawnFor).mockReturnValue(0);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const pipeline = (provider: FakeImageProvider | null, sleep = vi.fn(async () => undefined)) => {
  configureAvatarPipeline({ provider, sleep, random: () => 0.5 });
  return sleep;
};

describe("settling on the template at once", () => {
  test("the provider follows ASSESS_IMAGE_PROVIDER; a name it does not know gives none instead of sending the key elsewhere", () => {
    expect(providerFromEnv({ ASSESS_IMAGE_API_KEY: "k", ASSESS_IMAGE_PROVIDER: "ark", ASSESS_IMAGE_MODEL: "doubao-seedream-x" })?.label).toBe("ark:doubao-seedream-x");
    expect(providerFromEnv({ ASSESS_IMAGE_API_KEY: "k", ASSESS_IMAGE_PROVIDER: " Ark " })?.label).toBe("ark:doubao-seedream-4-0-250828");
    expect(providerFromEnv({ ASSESS_IMAGE_API_KEY: "k" })?.label).toBe("siliconflow:black-forest-labs/FLUX.1-Kontext-dev");
    expect(providerFromEnv({ ASSESS_IMAGE_API_KEY: "k", ASSESS_IMAGE_PROVIDER: "volcengine" })).toBeNull();
    expect(providerSummary({})).toEqual({ provider: "none", reason: expect.stringContaining("ASSESS_IMAGE_API_KEY") });
    expect(providerSummary({ ASSESS_IMAGE_API_KEY: "k", ASSESS_IMAGE_PROVIDER: "volcengine" })).toEqual({ provider: "none", reason: expect.stringContaining("volcengine") });
    expect(providerSummary({ ASSESS_IMAGE_API_KEY: "k" })).toEqual({ provider: "siliconflow", model: "black-forest-labs/FLUX.1-Kontext-dev", reason: expect.stringContaining("ark") });
    expect(providerSummary({ ASSESS_IMAGE_API_KEY: "secret-key", ASSESS_IMAGE_PROVIDER: "ark", ASSESS_IMAGE_MODEL: "m" })).toEqual({ provider: "ark", model: "m" });
    expect(JSON.stringify(providerSummary({ ASSESS_IMAGE_API_KEY: "secret-key" }))).not.toContain("secret-key");
  });

  test("with no image key there is no provider, and the figure is the template", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(providerFromEnv({})).toBeNull();
    pipeline(null);
    enqueueAvatar(storedResult());
    await avatarQueueIdle();
    expect(states()).toEqual(["template"]);
  });

  test("an address that has had its three figures gets the template, and the model is not called", async () => {
    const provider = new FakeImageProvider();
    pipeline(provider);
    vi.mocked(avatarsDrawnFor).mockReturnValue(3);
    enqueueAvatar(storedResult());
    await avatarQueueIdle();
    expect(states()).toEqual(["template"]);
    expect(provider.edits).toHaveLength(0);
  });

  test("once today's budget is spent, every further figure is the template", async () => {
    vi.stubEnv("ASSESS_IMAGE_DAILY_LIMIT", "1");
    const provider = new FakeImageProvider();
    pipeline(provider);
    enqueueAvatar(storedResult({ id: "res_a" }));
    enqueueAvatar(storedResult({ id: "res_b" }));
    await avatarQueueIdle();
    expect(vi.mocked(setAvatarState).mock.calls.filter((call) => call[0] === "res_b").map((call) => call[1])).toEqual(["template"]);
    expect(provider.edits).toHaveLength(1);
    expect(spentToday()).toBe(1);
  });
});

describe("drawing", () => {
  test("a drawn figure walks queued → drawing → ready and is written under the data directory", async () => {
    const provider = new FakeImageProvider([TINY_PNG]);
    pipeline(provider);
    const result = storedResult();
    enqueueAvatar(result);
    await avatarQueueIdle();
    expect(states()).toEqual(["queued", "drawing", "ready"]);
    const file = vi.mocked(setAvatarState).mock.calls.at(-1)![2]!;
    expect(file).toBe(path.join("avatars", "res_0001.png"));
    expect(fs.readFileSync(path.join(dir, file))).toEqual(TINY_PNG);
    expect(provider.edits[0]!.reference.equals(fs.readFileSync(templateImagePath("GEMA")))).toBe(true);

    const ready = { ...result, avatar: { state: "ready" as const, file } };
    expect(avatarStatus(ready).url).toMatch(/^\/api\/avatar\/inv_public_token_0001\.png\?v=\d+$/);
    expect(avatarStatus(ready).state).toBe("ready");
    expect(avatarImagePath(ready)).toBe(path.join(dir, file));
  });

  test("a failed call settles on the template", async () => {
    const provider = new FakeImageProvider([new ProviderError("IMAGE_API_400: bad prompt", 400)]);
    const sleep = pipeline(provider);
    enqueueAvatar(storedResult());
    await avatarQueueIdle();
    expect(states()).toEqual(["queued", "drawing", "template"]);
    expect(provider.edits).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, "avatars"))).toBe(false);
  });

  test("a rate limit is retried once after a wait, and the retry takes a budget slot too", async () => {
    const provider = new FakeImageProvider([new ProviderError("IMAGE_API_429", 429, 3_000), TINY_PNG]);
    const sleep = pipeline(provider);
    enqueueAvatar(storedResult());
    await avatarQueueIdle();
    expect(states()).toEqual(["queued", "drawing", "ready"]);
    expect(provider.edits).toHaveLength(2);
    expect(provider.edits[0]!.seed).toBe(provider.edits[1]!.seed);
    expect(sleep).toHaveBeenCalledWith(3_500);
    expect(spentToday()).toBe(2);
  });

  test("every fallback says why in the server log: skipped with its reason, or failed with the provider's answer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const events = () => warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    pipeline(null);
    enqueueAvatar(storedResult({ id: "res_none" }));
    pipeline(new FakeImageProvider());
    vi.mocked(avatarsDrawnFor).mockReturnValue(3);
    enqueueAvatar(storedResult({ id: "res_full" }));
    vi.mocked(avatarsDrawnFor).mockReturnValue(0);
    pipeline(new FakeImageProvider([new ProviderError("IMAGE_API_401: bad key", 401)]));
    enqueueAvatar(storedResult({ id: "res_401" }));
    await avatarQueueIdle();
    expect(events()).toEqual([
      { event: "avatar.skipped", resultId: "res_none", reason: "no_provider" },
      { event: "avatar.skipped", resultId: "res_full", reason: "email_limit" },
      expect.objectContaining({ event: "avatar.failed", resultId: "res_401", status: 401, reason: "IMAGE_API_401: bad key", attempts: 1 })
    ]);
    warn.mockRestore();
  });

  test("an image the poster cannot print (WebP) is refused rather than shown on the page and missing from the poster", async () => {
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
    pipeline(new FakeImageProvider([webp]));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    enqueueAvatar(storedResult());
    await avatarQueueIdle();
    expect(states()).toEqual(["queued", "drawing", "template"]);
  });

  test("a second overload after the retry gives up on the template", async () => {
    const provider = new FakeImageProvider([new ProviderError("IMAGE_API_503", 503), new ProviderError("IMAGE_API_503", 503)]);
    pipeline(provider);
    enqueueAvatar(storedResult());
    await avatarQueueIdle();
    expect(states()).toEqual(["queued", "drawing", "template"]);
    expect(provider.edits).toHaveLength(2);
  });
});

describe("what the pages and posters are given", () => {
  test("anything not ready shows the template address, and a figure lost to a restart reads as the template", () => {
    pipeline(null);
    expect(avatarStatus(storedResult({ avatar: { state: "drawing", file: "" } }))).toEqual({ state: "drawing", url: "/api/avatar/inv_public_token_0001.png" });
    const old = storedResult({ avatar: { state: "queued", file: "" }, createdAt: new Date(Date.now() - 3_600_000).toISOString() });
    expect(avatarStatus(old)).toEqual({ state: "template", url: "/api/avatar/inv_public_token_0001.png" });
    const missing = storedResult({ avatar: { state: "ready", file: "avatars/gone.png" } });
    expect(avatarStatus(missing).state).toBe("template");
    expect(avatarImagePath(missing)).toBe(templateImagePath("GEMA"));
  });

  test("every type has a woman's and a man's template PNG on disk, full length 2:3", () => {
    for (const code of ["SEMP", "SEMA", "SERP", "SERA", "SIMP", "SIMA", "SIRP", "SIRA", "GEMP", "GEMA", "GERP", "GERA", "GIMP", "GIMA", "GIRP", "GIRA"]) {
      for (const variant of ["female", "male"] as const) {
        const png = fs.readFileSync(templateImagePath(code, variant));
        expect(png.subarray(1, 4).toString()).toBe("PNG");
        expect(png.readUInt32BE(20) / png.readUInt32BE(16)).toBeCloseTo(1.5, 2);
      }
    }
    expect(() => templateImagePath("../x")).toThrow(/AVATAR_TYPE_UNKNOWN/);
  });

  test("the template follows how the person presents; 中性 gets one of the two, the same one every time", () => {
    pipeline(null);
    const man = storedResult({ appearance: { ...storedResult().appearance, presentation: "male" } });
    expect(avatarImagePath(man)).toBe(templateImagePath("GEMA", "male"));
    expect(avatarImagePath(storedResult())).toBe(templateImagePath("GEMA", "female"));
    expect(templateVariant("neutral", "res_a")).toBe(templateVariant("neutral", "res_a"));
    const picks = new Set(Array.from({ length: 20 }, (_, index) => templateVariant("neutral", `res_${index}`)));
    expect([...picks].sort()).toEqual(["female", "male"]);
  });
});

describe("the daily budget", () => {
  test("counts per day in UTC+8 and starts again the next day", () => {
    const evening = new Date("2026-10-14T15:30:00Z"); // 23:30 in Beijing
    const nextMorning = new Date("2026-10-14T16:30:00Z"); // 00:30 the next day
    expect(budgetDay(evening)).toBe("2026-10-14");
    expect(budgetDay(nextMorning)).toBe("2026-10-15");
    expect(takeSlot(2, evening)).toBe(true);
    expect(takeSlot(2, evening)).toBe(true);
    expect(takeSlot(2, evening)).toBe(false);
    expect(spentToday(evening)).toBe(2);
    expect(takeSlot(2, nextMorning)).toBe(true);
    expect(spentToday(nextMorning)).toBe(1);
    expect(JSON.parse(fs.readFileSync(budgetFile(), "utf8"))).toEqual({ day: "2026-10-15", count: 1 });
  });

  test("an unreadable budget file counts as a fresh day rather than blocking", () => {
    fs.writeFileSync(budgetFile(), "{not json");
    expect(takeSlot(1)).toBe(true);
    expect(takeSlot(1)).toBe(false);
  });
});

describe("downloading the drawn image", () => {
  const png = () => new Response(new Uint8Array(TINY_PNG), { status: 200 });

  test("only https, never with the key, and only image bytes", async () => {
    const fetchImpl = vi.fn(async () => png());
    await expect(downloadImage("http://cdn.example.com/a.png", fetchImpl as unknown as typeof fetch)).rejects.toThrow(/NOT_HTTPS/);
    await expect(downloadImage("https://u:p@cdn.example.com/a.png", fetchImpl as unknown as typeof fetch)).rejects.toThrow(/NOT_HTTPS/);
    expect(await downloadImage("https://cdn.example.com/a.png", fetchImpl as unknown as typeof fetch)).toEqual(TINY_PNG);
    expect(JSON.stringify(fetchImpl.mock.calls)).not.toMatch(/authorization/i);
    const html = vi.fn(async () => new Response("<html>", { status: 200 }));
    await expect(downloadImage("https://cdn.example.com/a.png", html as unknown as typeof fetch)).rejects.toThrow(/NOT_AN_IMAGE/);
  });

  test("a redirect to plain http is refused, and an oversized body is cut off", async () => {
    const redirect = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://evil.example.com/x.png" } }));
    await expect(downloadImage("https://cdn.example.com/a.png", redirect as unknown as typeof fetch)).rejects.toThrow(/NOT_HTTPS/);
    const huge = vi.fn(async () => new Response(new Uint8Array(13 * 1024 * 1024), { status: 200 }));
    await expect(downloadImage("https://cdn.example.com/a.png", huge as unknown as typeof fetch)).rejects.toThrow(/TOO_LARGE/);
  });
});
