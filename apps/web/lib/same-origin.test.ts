import { expect, test, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { isCrossSiteWrite } from "./same-origin";

const request = (headers: Record<string, string>) =>
  new Request("http://localhost:3210/api/thing", { method: "POST", headers });

test("a same-origin browser write is allowed even when the server rebuilt a different URL", () => {
  // The whole bug: `next start --hostname 127.0.0.1` answers a request whose reconstructed URL says
  // localhost, so comparing Origin against it refused every real POST from the browser — Analyze,
  // every execution action and the consent toggle were all 403 and the write path was unreachable.
  expect(isCrossSiteWrite(request({ origin: "http://127.0.0.1:3210", host: "127.0.0.1:3210" }))).toBe(false);
});

test("a write from another site is refused", () => {
  expect(isCrossSiteWrite(request({ origin: "https://evil.example", host: "127.0.0.1:3210" }))).toBe(true);
  // Same host, different port is still another origin as far as a browser is concerned.
  expect(isCrossSiteWrite(request({ origin: "http://127.0.0.1:4000", host: "127.0.0.1:3210" }))).toBe(true);
});

test("a caller with no Origin is a local tool, not a cross-site form post", () => {
  // curl and the worker send no Origin. The guard exists to stop another site, not the owner's shell.
  expect(isCrossSiteWrite(request({ host: "127.0.0.1:3210" }))).toBe(false);
});

test("an unparseable Origin is not trusted", () => {
  expect(isCrossSiteWrite(request({ origin: "not-a-url", host: "127.0.0.1:3210" }))).toBe(true);
  expect(isCrossSiteWrite(request({ origin: "http://127.0.0.1:3210" }))).toBe(true);
});
