import { expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { ASSESS_DECLINED_SETTING, ASSESS_RESULT_SETTING } from "@crossline/core";
import { assessFigure, assessOffer, decideAssess } from "./assess-link";

const env = { ASSESS_BASE_URL: "http://127.0.0.1:3340/", ASSESS_LINK_SECRET: "s3cret" } as unknown as NodeJS.ProcessEnv;
const found = { found: true, code: "DLBV", typeName: "联络官", group: "DL", axes: { concentration: 70, orientation: 40, boundary: 80, pacing: 65 },
  takenAt: "2026-10-14T10:00:00.000Z", resultUrl: "http://127.0.0.1:3340/r/abc" };
const answering = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }));
function memory() {
  const values = new Map<string, string>();
  return { getSetting: (_: string, key: string) => values.get(key), setSetting: (_: string, key: string, value: string) => void values.set(key, value),
    deleteSetting: (_: string, key: string) => void values.delete(key), values };
}

test("off without both variables; nothing is asked", async () => {
  const fetcher = answering(found);
  expect(await assessOffer(memory(), "ws", "a@b.c", fetcher, { ASSESS_BASE_URL: "http://x" } as unknown as NodeJS.ProcessEnv)).toEqual({ state: "off" });
  expect(fetcher).not.toHaveBeenCalled();
});

test("asks with the bearer secret and the verified address; found is offered and nothing is written until it is used", async () => {
  const store = memory(), fetcher = answering(found);
  const offer = await assessOffer(store, "ws", "a@b.c", fetcher, env);
  expect(offer).toMatchObject({ state: "offered", result: { code: "DLBV", typeName: "联络官" } });
  expect(fetcher).toHaveBeenCalledWith("http://127.0.0.1:3340/api/link", expect.objectContaining({ method: "POST", body: JSON.stringify({ email: "a@b.c" }),
    headers: expect.objectContaining({ authorization: "Bearer s3cret" }) }));
  expect(store.values.size).toBe(0);
  const used = await decideAssess(store, "ws", "a@b.c", "use", fetcher, env, new Date("2026-10-15T08:00:00Z"));
  expect(used).toMatchObject({ state: "used", result: { source: "public-assess", acceptedAt: "2026-10-15T08:00:00.000Z", axes: found.axes } });
  expect(JSON.parse(store.values.get(ASSESS_RESULT_SETTING)!)).toMatchObject({ code: "DLBV", source: "public-assess" });
  expect(await assessOffer(store, "ws", "a@b.c", answering({ found: false }), env)).toMatchObject({ state: "used" });
});

test("an unverified address, not found, unreachable or a malformed answer is none, silently", async () => {
  expect(await assessOffer(memory(), "ws", undefined, answering(found), env)).toEqual({ state: "none" });
  expect(await assessOffer(memory(), "ws", "a@b.c", answering({ found: false }), env)).toEqual({ state: "none" });
  expect(await assessOffer(memory(), "ws", "a@b.c", vi.fn(async () => { throw new Error("ECONNREFUSED"); }), env)).toEqual({ state: "none" });
  expect(await assessOffer(memory(), "ws", "a@b.c", answering({ ...found, appearance: "x" }), env)).toEqual({ state: "none" });
  expect(await assessOffer(memory(), "ws", "a@b.c", answering({ error: "nope" }, 401), env)).toEqual({ state: "none" });
});

test("「不是我的结果」 or removing deletes it and stops asking", async () => {
  const store = memory(), fetcher = answering(found);
  await decideAssess(store, "ws", "a@b.c", "use", fetcher, env);
  expect(await decideAssess(store, "ws", "a@b.c", "reject", fetcher, env)).toEqual({ state: "declined" });
  expect(store.values.has(ASSESS_RESULT_SETTING)).toBe(false);
  expect(store.values.has(ASSESS_DECLINED_SETTING)).toBe(true);
  fetcher.mockClear();
  expect(await assessOffer(store, "ws", "a@b.c", fetcher, env)).toEqual({ state: "declined" });
  expect(await decideAssess(store, "ws", "a@b.c", "use", fetcher, env)).toEqual({ state: "none" });
  expect(fetcher).not.toHaveBeenCalled();
});

test("the figure is fetched only from the test server's own origin and only as an image", async () => {
  const image = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }));
  type Figured = Parameters<typeof assessFigure>[0];
  const result = { ...found, found: true, figureUrl: "http://127.0.0.1:3340/api/figure/DLBV.png" } as unknown as Figured;
  expect((await assessFigure(result, image, env))?.type).toBe("image/png");
  expect(await assessFigure({ ...result, figureUrl: "http://169.254.169.254/latest" } as unknown as Figured, image, env)).toBeUndefined();
  expect(await assessFigure(result, vi.fn(async () => new Response("<html>", { headers: { "content-type": "text/html" } })), env)).toBeUndefined();
  expect(await assessFigure({ ...found, found: true } as Figured, image, env)).toBeUndefined();
});
