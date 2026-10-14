import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RESULT_RETENTION_DAYS } from "../lib/contract";
import { runPurge } from "./purge";
import { RateLimiter, clientIp, crossSiteWrite, normaliseEmail, stripInvisible } from "./security";
import { createResult, getResultById } from "./store";
import { appearance, useTempDataDir } from "./testing";

const request = (headers: Record<string, string>) => new Request("http://assess.test/api/results", { method: "POST", headers });

test("the client address is the right-most forwarded entry, which the proxy itself wrote", () => {
  expect(clientIp(request({ "x-forwarded-for": "1.2.3.4, 203.0.113.7" }))).toBe("203.0.113.7");
  expect(clientIp(request({ "x-forwarded-for": "::ffff:198.51.100.2" }))).toBe("198.51.100.2");
  expect(clientIp(request({}))).toBe("unknown");
});

test("a window refuses past its limit and opens again once it has passed", () => {
  const limiter = new RateLimiter(2, 1000);
  expect(limiter.hit("k", 0).ok).toBe(true);
  expect(limiter.hit("k", 10).ok).toBe(true);
  expect(limiter.hit("k", 20)).toEqual({ ok: false, retryAfter: 1 });
  expect(limiter.blocked("k", 500)).toBe(1);
  expect(limiter.hit("other", 20).ok).toBe(true);
  expect(limiter.hit("k", 1011).ok).toBe(true);
});

test("addresses are trimmed, lowercased and checked for shape and length", () => {
  expect(normaliseEmail("  Someone@QQ.com ")).toBe("someone@qq.com");
  expect(normaliseEmail("a.b+tag@mail.163.com")).toBe("a.b+tag@mail.163.com");
  for (const bad of ["", "a@b", "a@@b.com", "a b@c.com", "<a@b.com>", "a@b..com", "a@b.c", 42, `${"x".repeat(65)}@a.com`]) {
    expect(normaliseEmail(bad)).toBeUndefined();
  }
});

test("a write is cross-site only when its Origin names another host", () => {
  expect(crossSiteWrite(request({ host: "assess.test" }))).toBe(false);
  expect(crossSiteWrite(request({ host: "assess.test", origin: "https://assess.test" }))).toBe(false);
  expect(crossSiteWrite(request({ host: "app:3000", "x-forwarded-host": "assess.test", origin: "https://assess.test" }))).toBe(false);
  expect(crossSiteWrite(request({ host: "assess.test", origin: "https://evil.example" }))).toBe(true);
  expect(crossSiteWrite(request({ host: "assess.test", origin: "null" }))).toBe(true);
});

test("invisible characters are stripped, visible ones kept", () => {
  expect(stripInvisible("戴​眼⁦镜\u0007 🙂")).toBe("戴眼镜 🙂");
});

const temp = useTempDataDir();
beforeEach(() => { temp.dir(); vi.spyOn(console, "info").mockImplementation(() => {}); });
afterEach(() => { temp.cleanup(); vi.restoreAllMocks(); });

test("the purge removes only results past their retention", () => {
  const input = { email: "a@example.com", nickname: "", scores: { scope: 50, basis: 50, output: 50, rhythm: 50 }, code: "GIRA", appearance, sendEmail: false };
  const old = createResult(input, new Date(Date.now() - RESULT_RETENTION_DAYS * 86_400_000 - 1000));
  const fresh = createResult(input);
  expect(runPurge()).toBe(1);
  expect(getResultById(old.id)).toBeUndefined();
  expect(getResultById(fresh.id)).toBeDefined();
});
