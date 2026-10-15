import { afterEach, beforeEach, expect, test } from "vitest";
import { parseAssessLinkResponse } from "@crossline/core/assess";
import { linkLookups, resetRateLimits } from "../../../server/security";
import { createResult, deleteResult, getResultById, keepOnlyNewest } from "../../../server/store";
import { appearance, useTempDataDir } from "../../../server/testing";
import { POST } from "./route";

const temp = useTempDataDir();
const SECRET = "link-secret-for-tests-0123456789";

beforeEach(() => {
  temp.dir();
  resetRateLimits();
  process.env.ASSESS_LINK_SECRET = SECRET;
  process.env.ASSESS_BASE_URL = "https://assess.example";
});
afterEach(() => {
  temp.cleanup();
  delete process.env.ASSESS_LINK_SECRET;
  delete process.env.ASSESS_BASE_URL;
});

const ask = (body: unknown, auth: string | null = `Bearer ${SECRET}`, ip = "203.0.113.7") => POST(new Request("http://assess.test/api/link", {
  method: "POST",
  headers: { "content-type": "application/json", host: "assess.test", "x-forwarded-for": ip, ...(auth === null ? {} : { authorization: auth }) },
  body: JSON.stringify(body)
}));

const stored = (email: string, scores = { scope: 80, basis: 30, output: 72, rhythm: 66 }, code = "GERA", now?: Date) =>
  createResult({ email, nickname: "小鹿", scores, code, appearance: { ...appearance, note: "红帽子" }, sendEmail: true }, now);

test("without ASSESS_LINK_SECRET the route does not exist", async () => {
  delete process.env.ASSESS_LINK_SECRET;
  stored("a@example.com");
  expect((await ask({ email: "a@example.com" })).status).toBe(404);
  expect((await ask({ email: "a@example.com" }, null)).status).toBe(404);
});

test("a missing, wrong or differently long secret is 401 and reveals nothing", async () => {
  stored("a@example.com");
  for (const auth of [null, "Bearer ", "Bearer wrong", `Bearer ${SECRET}x`, SECRET, `Basic ${SECRET}`]) {
    const response = await ask({ email: "a@example.com" }, auth);
    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("GERA");
  }
});

test("the newest live result under the address: type and scores only, never appearance, nickname or anyone else", async () => {
  stored("other@example.com", { scope: 10, basis: 90, output: 10, rhythm: 10 }, "SIMP");
  stored("a@example.com", { scope: 20, basis: 20, output: 20, rhythm: 20 }, "SEMP", new Date(Date.now() - 86_400_000));
  const latest = stored("a@example.com");
  const response = await ask({ email: "  A@Example.com " });
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toEqual({
    found: true, code: "GERA", typeName: "联络官", group: "GE", axes: { scope: 80, basis: 30, output: 72, rhythm: 66 },
    takenAt: latest.createdAt, resultUrl: `https://assess.example/r/${latest.resultToken}`,
    figureUrl: `https://assess.example/api/avatar/${latest.inviteToken}.png?size=small`
  });
  expect(parseAssessLinkResponse(body)).toEqual(body);
  const text = JSON.stringify(body);
  // The figure is addressed by the invitation token, which is public anyway (it is the poster's QR code).
  for (const leaked of ["小鹿", "红帽子", "a@example.com", "SIMP"]) expect(text).not.toContain(leaked);
});

test("an address with no result, or whose result was deleted, is found: false", async () => {
  expect(await (await ask({ email: "nobody@example.com" })).json()).toEqual({ found: false });
  const result = stored("gone@example.com");
  expect((await (await ask({ email: "gone@example.com" })).json()).found).toBe(true);
  deleteResult(result.id);
  expect(await (await ask({ email: "gone@example.com" })).json()).toEqual({ found: false });
});

test("a malformed address is refused, and lookups are rate limited per address, wrong secrets included", async () => {
  expect((await ask({ email: "not-an-address" })).status).toBe(400);
  expect((await ask({})).status).toBe(400);
  for (let index = 2; index < linkLookups.limit; index++) await ask({ email: "x@example.com" }, "Bearer wrong");
  expect((await ask({ email: "x@example.com" })).status).toBe(429);
  expect((await ask({ email: "x@example.com" }, `Bearer ${SECRET}`, "198.51.100.4")).status).toBe(200);
});

test("the response parser refuses anything off-contract", () => {
  const good = { found: true, code: "GERA", typeName: "联络官", group: "GE", axes: { scope: 80, basis: 30, output: 72, rhythm: 66 }, takenAt: "2026-10-15T00:00:00.000Z" };
  expect(parseAssessLinkResponse(good)).toEqual(good);
  expect(parseAssessLinkResponse({ found: false })).toEqual({ found: false });
  expect(parseAssessLinkResponse({ found: false, code: "GERA" })).toBeNull();
  expect(parseAssessLinkResponse({ ...good, nickname: "小鹿" })).toBeNull();
  expect(parseAssessLinkResponse({ ...good, code: "XXXX" })).toBeNull();
  expect(parseAssessLinkResponse({ ...good, group: "SE" })).toBeNull();
  expect(parseAssessLinkResponse({ ...good, axes: { ...good.axes, scope: 101 } })).toBeNull();
  expect(parseAssessLinkResponse({ ...good, axes: { scope: 1, basis: 2, output: 3 } })).toBeNull();
  expect(parseAssessLinkResponse({ ...good, takenAt: "yesterday" })).toBeNull();
  expect(parseAssessLinkResponse({ ...good, resultUrl: "javascript:alert(1)" })).toBeNull();
  expect(parseAssessLinkResponse({ ...good, figureUrl: "javascript:alert(1)" })).toBeNull();
  expect(parseAssessLinkResponse({ ...good, figureUrl: 42 })).toBeNull();
  const figure = { ...good, figureUrl: "https://assess.example/api/avatar/abc.png?size=small" };
  expect(parseAssessLinkResponse(figure)).toEqual(figure);
  expect(parseAssessLinkResponse(null)).toBeNull();
});

test("with only the newest result kept per address, the link answers that one", async () => {
  const old = stored("one@example.com", { scope: 20, basis: 20, output: 20, rhythm: 20 }, "SEMP", new Date(Date.now() - 60_000));
  keepOnlyNewest(old);
  const newest = stored("one@example.com");
  keepOnlyNewest(newest);
  expect(getResultById(old.id)).toBeUndefined();
  expect(await (await ask({ email: "one@example.com" })).json()).toMatchObject({ found: true, code: "GERA", takenAt: newest.createdAt });
});

test("without ASSESS_BASE_URL neither link is given", async () => {
  delete process.env.ASSESS_BASE_URL;
  stored("nobase@example.com");
  const body = await (await ask({ email: "nobase@example.com" })).json();
  expect(body.found).toBe(true);
  expect(body).not.toHaveProperty("resultUrl");
  expect(body).not.toHaveProperty("figureUrl");
});
