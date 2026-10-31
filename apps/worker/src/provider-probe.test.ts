import { expect, test } from "vitest";
import { maskedSnippet, probeProvider, type ProbeDeps } from "./provider-probe";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
/** Answers `/models` and the one request with what each test gives. */
const deps = (models: Response, request: () => Response): ProbeDeps => ({ isPublicHost: async () => true,
  fetchImpl: (async (url: string) => url.endsWith("/models") ? models : request()) as typeof fetch });
const relay = { kind: "chat" as const, baseUrl: "https://relay.example.com/v1", model: "gpt-4o-mini" };
const KEY = "sk-relay-secret-ab12";

test("a relay that answers is reached", async () => {
  expect(await probeProvider(relay, KEY, deps(json({ data: [{ id: "gpt-4o-mini" }] }), () => json({ choices: [] })))).toEqual({ ok: true });
  // A relay without a model list still counts once the request itself answers; a refusal for load proves the rest is right.
  expect(await probeProvider(relay, KEY, deps(json({}, 404), () => json({ choices: [] })))).toEqual({ ok: true });
  expect(await probeProvider(relay, KEY, deps(json({}, 404), () => json({ error: { message: "rate limited" } }, 429)))).toEqual({ ok: true });
});

test("the four usual failures are named: key, path, model, balance", async () => {
  expect(await probeProvider(relay, KEY, deps(json({}, 401), () => json({})))).toMatchObject({ ok: false, code: "PROVIDER_KEY_INVALID" });
  // A base URL without /v1: a 404, or the relay's own web page, and the hint says so.
  const noV1 = { ...relay, baseUrl: "https://relay.example.com" };
  expect(await probeProvider(noV1, KEY, deps(json({}, 404), () => json({ error: { message: "Not Found" } }, 404))))
    .toMatchObject({ ok: false, code: "PROVIDER_PATH_WRONG", message: expect.stringContaining("/v1") });
  expect(await probeProvider(noV1, KEY, deps(json({}, 404), () => new Response("<!doctype html><html>", { status: 200, headers: { "content-type": "text/html" } }))))
    .toMatchObject({ ok: false, code: "PROVIDER_PATH_WRONG", message: expect.stringContaining("/v1") });
  // A model the relay does not carry: the ones it lists that look alike are offered.
  const model = await probeProvider({ ...relay, model: "gpt-4o-mni" }, KEY,
    deps(json({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "claude-sonnet-4" }] }), () => json({ error: { message: "当前分组 default 下对于模型 gpt-4o-mni 无可用渠道" } }, 503)));
  expect(model).toMatchObject({ ok: false, code: "PROVIDER_MODEL_UNKNOWN", message: expect.stringContaining("gpt-4o-mini") });
  expect(model.ok ? "" : model.message).not.toContain("claude");
  expect(await probeProvider(relay, KEY, deps(json({ data: [] }), () => json({ error: { message: "Insufficient account balance" } }, 403))))
    .toMatchObject({ ok: false, code: "PROVIDER_BALANCE" });
  expect(await probeProvider(relay, KEY, deps(json({ data: [] }), () => json({ error: { message: "额度不足" } }, 400))))
    .toMatchObject({ ok: false, code: "PROVIDER_BALANCE" });
});

test("a redirect is not followed, an unreachable name is said, and a private name is never contacted", async () => {
  expect(await probeProvider(relay, KEY, deps(json({}, 404), () => new Response("", { status: 302, headers: { location: "http://10.0.0.1/" } }))))
    .toMatchObject({ ok: false, code: "PROVIDER_REDIRECT" });
  const down: ProbeDeps = { isPublicHost: async () => true, fetchImpl: (async () => { throw new TypeError("fetch failed"); }) as typeof fetch };
  expect(await probeProvider(relay, KEY, down)).toMatchObject({ ok: false, code: "PROVIDER_UNREACHABLE" });
  let contacted = false;
  const internal: ProbeDeps = { isPublicHost: async () => false, fetchImpl: (async () => { contacted = true; return json({}); }) as typeof fetch };
  expect(await probeProvider(relay, KEY, internal)).toMatchObject({ ok: false, code: "PROVIDER_ADDRESS_PRIVATE" });
  expect(contacted).toBe(false);
});

test("what the relay said is shown without the key, or anything shaped like one", async () => {
  const echoed = await probeProvider(relay, KEY, deps(json({}, 404), () => json({ error: { message: `upstream error for ${KEY}, also sk-other-key-1234567890` } }, 500)));
  expect(echoed).toMatchObject({ ok: false, code: "PROVIDER_UPSTREAM_ERROR" });
  expect(JSON.stringify(echoed)).not.toContain("secret");
  expect(JSON.stringify(echoed)).not.toContain("other-key-12345");
  expect(maskedSnippet(`bad ${KEY}`, KEY)).toBe("bad ···ab12");
});
