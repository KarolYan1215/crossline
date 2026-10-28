import { describe, expect, test } from "vitest";
import { contentSecurityPolicy, newNonce } from "./csp";

const scriptSrc = (policy: string) => policy.split("; ").find((part) => part.startsWith("script-src"))!;

describe("the content security policy", () => {
  test("a page's scripts run by nonce, never by 'unsafe-inline'", () => {
    const nonce = newNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(newNonce()).not.toBe(nonce);
    const policy = contentSecurityPolicy(nonce);
    expect(scriptSrc(policy)).toBe(`script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
  });

  test("a response that is not a page (an assistant's file, the service worker) runs no inline script at all", () => {
    expect(scriptSrc(contentSecurityPolicy())).toBe("script-src 'self' 'wasm-unsafe-eval'");
  });
});
