import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { avatarsDrawnFor, forgetFailedDraw, setAvatarState } from "../store";
import { budgetDay, budgetFile, dailyLimit, spentToday, takeSlot } from "./budget";
import { FakeImageProvider, TINY_PNG } from "./fake-provider";
import { RETRY_AFTER_MS, avatarImagePath, avatarQueueIdle, avatarStatus, configureAvatarPipeline, enqueueAvatar, retryAvatarIfDue, templateImagePath } from "./index";
import { ARK_DEFAULT_MODEL, ArkProvider, ProviderError, arkSize, downloadImage, providerFromEnv, providerSummary } from "./provider";
import { storedResult } from "./testing";
import { templateVariant } from "./templates";

vi.mock("../store", () => ({ setAvatarState: vi.fn(), avatarsDrawnFor: vi.fn(() => 0), forgetFailedDraw: vi.fn() }));

const states = () => vi.mocked(setAvatarState).mock.calls.map((call) => call[1]);
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "assess-avatar-"));
  vi.stubEnv("ASSESS_DATA_DIR", dir);
  vi.stubEnv("ASSESS_IMAGE_DAILY_LIMIT", "");
  vi.mocked(setAvatarState).mockClear();
  vi.mocked(forgetFailedDraw).mockClear();
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
  test("the provider follows ASSESS_IMAGE_PROVIDER, its other names, or the key when it is unset or empty; an unknown name gives none", () => {
    expect(providerFromEnv({ ASSESS_IMAGE_API_KEY: "k", ASSESS_IMAGE_PROVIDER: "ark", ASSESS_IMAGE_MODEL: "doubao-seedream-x" })?.label).toBe("ark:doubao-seedream-x");
    expect(providerFromEnv({ ASSESS_IMAGE_API_KEY: "k", ASSESS_IMAGE_PROVIDER: " Ark " })?.label).toBe(`ark:${ARK_DEFAULT_MODEL}`);
    expect(providerFromEnv({ ASSESS_IMAGE_API_KEY: "k", ASSESS_IMAGE_PROVIDER: "volcengine" })?.label).toBe(`ark:${ARK_DEFAULT_MODEL}`);
    // An env file line with nothing after `=` is unset: an Ark key (a UUID) means Ark, a SiliconFlow key starts with sk-.
    const arkKey = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
    expect(providerFromEnv({ ASSESS_IMAGE_API_KEY: arkKey, ASSESS_IMAGE_PROVIDER: "", ASSESS_IMAGE_MODEL: "" })?.label).toBe(`ark:${ARK_DEFAULT_MODEL}`);
    expect(providerFromEnv({ ASSESS_IMAGE_API_KEY: "sk-abc" })?.label).toBe("siliconflow:black-forest-labs/FLUX.1-Kontext-dev");
    expect(providerFromEnv({ ASSESS_IMAGE_API_KEY: "sk-abc", ASSESS_IMAGE_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3" })?.label).toBe(`ark:${ARK_DEFAULT_MODEL}`);
    // A SiliconFlow model id left in the file is never sent to Ark.
    expect(providerFromEnv({ ASSESS_IMAGE_API_KEY: "k", ASSESS_IMAGE_PROVIDER: "ark", ASSESS_IMAGE_MODEL: "Qwen/Qwen-Image-Edit" })?.label).toBe(`ark:${ARK_DEFAULT_MODEL}`);
    expect(providerFromEnv({ ASSESS_IMAGE_API_KEY: "k", ASSESS_IMAGE_PROVIDER: "openai" })).toBeNull();
    expect(providerSummary({})).toEqual({ provider: "none", reason: expect.stringContaining("ASSESS_IMAGE_API_KEY") });
    expect(providerSummary({ ASSESS_IMAGE_API_KEY: "k", ASSESS_IMAGE_PROVIDER: "openai" })).toEqual({ provider: "none", reason: expect.stringContaining("openai") });
    expect(providerSummary({ ASSESS_IMAGE_API_KEY: arkKey, ASSESS_IMAGE_PROVIDER: "" }))
      .toEqual({ provider: "ark", model: ARK_DEFAULT_MODEL, size: "1024x1536", reason: expect.stringContaining("read off the key") });
    expect(providerSummary({ ASSESS_IMAGE_API_KEY: "secret-key", ASSESS_IMAGE_PROVIDER: "ark", ASSESS_IMAGE_MODEL: "doubao-seedream-4-5-251128" }))
      .toEqual({ provider: "ark", model: "doubao-seedream-4-5-251128", size: "1664x2496" });
    expect(providerSummary({ ASSESS_IMAGE_API_KEY: "k", ASSESS_IMAGE_PROVIDER: "ark", ASSESS_IMAGE_MODEL: "a/b" }).reason).toMatch(/not an Ark model id/);
    expect(JSON.stringify(providerSummary({ ASSESS_IMAGE_API_KEY: "secret-key" }))).not.toContain("secret-key");
    expect(JSON.stringify(providerSummary({ ASSESS_IMAGE_API_KEY: arkKey, ASSESS_IMAGE_PROVIDER: "ark" }))).not.toContain(arkKey);
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

  test("there is no daily ceiling unless one is set: each address's own limit is what bounds the figures", () => {
    expect(dailyLimit()).toBe(Number.POSITIVE_INFINITY);
    vi.stubEnv("ASSESS_IMAGE_DAILY_LIMIT", "40");
    expect(dailyLimit()).toBe(40);
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

  test("an overload on every try of the run gives up on the template", async () => {
    const provider = new FakeImageProvider([new ProviderError("IMAGE_API_503", 503), new ProviderError("IMAGE_API_503", 503), new ProviderError("IMAGE_API_503", 503)]);
    pipeline(provider);
    enqueueAvatar(storedResult());
    await avatarQueueIdle();
    expect(states()).toEqual(["queued", "drawing", "template"]);
    expect(provider.edits).toHaveLength(3);
  });
});

describe("after a failure", () => {
  test("a failed call gives the address its figure back; a drawn one does not", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    pipeline(new FakeImageProvider([new ProviderError("IMAGE_API_400: InvalidParameter", 400)]));
    enqueueAvatar(storedResult({ id: "res_bad" }));
    await avatarQueueIdle();
    expect(vi.mocked(forgetFailedDraw).mock.calls).toEqual([["res_bad"]]);
    pipeline(new FakeImageProvider([TINY_PNG]));
    enqueueAvatar(storedResult({ id: "res_good" }));
    await avatarQueueIdle();
    expect(vi.mocked(forgetFailedDraw).mock.calls).toEqual([["res_bad"]]);
  });

  test("a passing failure (a timeout, an overload) is drawn again on the person's visit a few minutes later; a refusal is not", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    let now = new Date("2026-10-16T09:00:00Z");
    const provider = new FakeImageProvider([new ProviderError("IMAGE_TIMEOUT", 504), new ProviderError("IMAGE_TIMEOUT", 504),
      new ProviderError("IMAGE_TIMEOUT", 504), TINY_PNG]);
    configureAvatarPipeline({ provider, sleep: vi.fn(async () => undefined), random: () => 0.5, now: () => now });
    const result = storedResult({ id: "res_slow" });
    enqueueAvatar(result);
    await avatarQueueIdle();
    expect(states()).toEqual(["queued", "drawing", "template"]);
    expect(JSON.parse(String(warn.mock.calls.at(-1)![0]))).toMatchObject({ event: "avatar.failed", status: 504, retryLater: true });
    const fallen = { ...result, avatar: { state: "template" as const, file: "" } };
    expect(retryAvatarIfDue(fallen)).toBe(false);
    now = new Date(now.getTime() + RETRY_AFTER_MS);
    expect(retryAvatarIfDue(fallen)).toBe(true);
    expect(retryAvatarIfDue(fallen)).toBe(false);
    await avatarQueueIdle();
    expect(states()).toEqual(["queued", "drawing", "template", "queued", "drawing", "ready"]);
    // The first visit's run made its call and two immediate tries more; the later visit drew it.
    expect(provider.edits).toHaveLength(4);

    vi.mocked(setAvatarState).mockClear();
    const refusing = new FakeImageProvider([new ProviderError("IMAGE_API_401: AuthenticationError", 401)]);
    configureAvatarPipeline({ provider: refusing, sleep: vi.fn(async () => undefined), random: () => 0.5, now: () => now });
    enqueueAvatar(storedResult({ id: "res_refused" }));
    await avatarQueueIdle();
    now = new Date(now.getTime() + 10 * RETRY_AFTER_MS);
    expect(retryAvatarIfDue(storedResult({ id: "res_refused", avatar: { state: "template", file: "" } }))).toBe(false);
    expect(refusing.edits).toHaveLength(1);
  });

  test("a figure queued again long after its result was made is not mistaken for one lost to a restart", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    let resolveDraw: (bytes: Buffer) => void = () => {};
    const slow = { label: "slow", generate: async () => TINY_PNG, edit: () => new Promise<Buffer>((resolve) => { resolveDraw = resolve; }) };
    configureAvatarPipeline({ provider: slow, sleep: vi.fn(async () => undefined), random: () => 0.5 });
    const old = storedResult({ id: "res_old", createdAt: new Date(Date.now() - 3_600_000).toISOString() });
    enqueueAvatar(old);
    expect(avatarStatus({ ...old, avatar: { state: "drawing", file: "" } }).state).toBe("drawing");
    resolveDraw(TINY_PNG);
    await avatarQueueIdle();
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
        // Only the header: the 32 templates are ~55 MB, and reading them whole timed this test out under a full parallel run.
        const png = Buffer.alloc(24);
        const fd = fs.openSync(templateImagePath(code, variant), "r");
        try { fs.readSync(fd, png, 0, 24, 0); } finally { fs.closeSync(fd); }
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

describe("Volcengine Ark's request", () => {
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const calls = (fetchImpl: ReturnType<typeof vi.fn>) => fetchImpl.mock.calls as unknown as Array<[string | URL, RequestInit]>;

  test("an edit sends the model, a size the model takes, the template as a lowercase PNG data URL, no seed and no watermark", async () => {
    const fetchImpl = vi.fn(async (url: string | URL) => String(url).endsWith("/images/generations")
      ? answer({ model: "m", created: 1, data: [{ url: "https://ark-content.tos-cn-beijing.volces.com/x.jpeg", size: "1024x1536" }] })
      : new Response(new Uint8Array(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0])), { status: 200 }));
    const provider = new ArkProvider({ apiKey: "ark-secret", model: "doubao-seedream-5-0-pro-260628", fetchImpl: fetchImpl as unknown as typeof fetch });
    const reference = fs.readFileSync(templateImagePath("GEMA"));
    const image = await provider.edit({ reference, prompt: "Edit this cartoon character.", seed: 3_000_000_000 });
    expect(image[0]).toBe(0xff);
    const [url, init] = calls(fetchImpl)[0]!;
    expect(String(url)).toBe("https://ark.cn-beijing.volces.com/api/v3/images/generations");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer ark-secret");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["image", "model", "prompt", "response_format", "size", "watermark"]);
    expect(body).toMatchObject({ model: "doubao-seedream-5-0-pro-260628", size: "1024x1536", response_format: "url", watermark: false,
      prompt: "Edit this cartoon character." });
    expect(String(body.image).startsWith("data:image/png;base64,")).toBe(true);
    expect(Buffer.from(String(body.image).split(",")[1]!, "base64").equals(reference)).toBe(true);
    // The template stays far under the 30 MB the API takes for an input image.
    expect(String(init.body).length).toBeLessThan(30 * 1024 * 1024);
    // The download goes to the link only, without the key.
    const [download, downloadInit] = calls(fetchImpl)[1]!;
    expect(String(download)).toBe("https://ark-content.tos-cn-beijing.volces.com/x.jpeg");
    expect(JSON.stringify(downloadInit)).not.toContain("ark-secret");
  });

  test("the size follows the model's pixel range: 1024×1536 where it is allowed, 1664×2496 for 4.5 and 5.0 lite, or ASSESS_IMAGE_SIZE", () => {
    for (const model of ["doubao-seedream-4-0-250828", "doubao-seedream-5-0-pro-260628", "doubao-seedream-5-0-flash-260628"]) expect(arkSize(model)).toBe("1024x1536");
    for (const model of ["doubao-seedream-4-5-251128", "doubao-seedream-5-0-260128", "doubao-seedream-5-0-lite-260128", "ep-20261016-abcde"]) {
      const [width, height] = arkSize(model).split("x").map(Number) as [number, number];
      expect(width * height).toBeGreaterThanOrEqual(2560 * 1440);
      expect(width * height).toBeLessThanOrEqual(2048 * 2048 * 1.1025);
      expect(height / width).toBe(1.5);
    }
    expect(arkSize("doubao-seedream-5-0-pro-260628", "2k")).toBe("2K");
    expect(arkSize("doubao-seedream-5-0-pro-260628", "1200X1800")).toBe("1200x1800");
    expect(arkSize("doubao-seedream-5-0-pro-260628", "huge; drop table")).toBe("1024x1536");
  });

  test("a refusal names Ark's error code in the log, and a 200 without a link says why", async () => {
    const refused = vi.fn(async () => answer({ error: { code: "ModelNotOpen", message: "Your account has not activated the model.", param: "", type: "Not Found" } }, 404));
    const provider = new ArkProvider({ apiKey: "k", fetchImpl: refused as unknown as typeof fetch });
    await expect(provider.edit({ reference: TINY_PNG, prompt: "p", seed: 1 })).rejects.toMatchObject({
      status: 404, message: "IMAGE_API_404: ModelNotOpen: Your account has not activated the model." });
    const empty = vi.fn(async () => answer({ data: [{ error: { code: "OutputImageSensitiveContentDetected", message: "blocked" } }] }));
    await expect(new ArkProvider({ apiKey: "k", fetchImpl: empty as unknown as typeof fetch }).edit({ reference: TINY_PNG, prompt: "p", seed: 1 }))
      .rejects.toMatchObject({ status: 502, message: "IMAGE_API_NO_URL: OutputImageSensitiveContentDetected: blocked" });
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
