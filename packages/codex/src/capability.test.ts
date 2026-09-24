import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { signCapability, verifyCapability } from "./capability";

const SECRET = "test-secret";
const BOOT_ID = "boot-1";
const CLAIMS = {
  principalId: "p1", workspaceId: "w1", role: "owner" as const,
  operation: "POST /v1/work-orders/wo-1/prepare-materials", requestId: "req-1", supervisorBootId: BOOT_ID
};

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

test("a freshly signed token verifies against the same operation and boot id", () => {
  const token = signCapability(CLAIMS, SECRET);
  const result = verifyCapability(token, SECRET, { operation: CLAIMS.operation, supervisorBootId: BOOT_ID });
  expect(result).toMatchObject({ ok: true, capability: { principalId: "p1", workspaceId: "w1" } });
});

test("no token is refused", () => {
  expect(verifyCapability(undefined, SECRET, { operation: CLAIMS.operation, supervisorBootId: BOOT_ID }))
    .toEqual({ ok: false, code: "CAPABILITY_MISSING" });
});

test("a token signed with a different secret is refused", () => {
  const token = signCapability(CLAIMS, SECRET);
  expect(verifyCapability(token, "wrong-secret", { operation: CLAIMS.operation, supervisorBootId: BOOT_ID }))
    .toEqual({ ok: false, code: "CAPABILITY_SIGNATURE_INVALID" });
});

test("a tampered payload is refused even with the original signature", () => {
  const token = signCapability(CLAIMS, SECRET);
  const [payload, signature] = token.split(".");
  const tampered = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
  tampered.role = "owner";
  tampered.principalId = "attacker";
  const forged = `${Buffer.from(JSON.stringify(tampered)).toString("base64url")}.${signature}`;
  expect(verifyCapability(forged, SECRET, { operation: CLAIMS.operation, supervisorBootId: BOOT_ID }).ok).toBe(false);
});

test("expires after 30 seconds", () => {
  const token = signCapability(CLAIMS, SECRET);
  vi.advanceTimersByTime(30_000);
  expect(verifyCapability(token, SECRET, { operation: CLAIMS.operation, supervisorBootId: BOOT_ID }))
    .toEqual({ ok: false, code: "CAPABILITY_EXPIRED" });
});

test("a token minted for one route is refused against another", () => {
  const token = signCapability(CLAIMS, SECRET);
  expect(verifyCapability(token, SECRET, { operation: "GET /v1/codex/account", supervisorBootId: BOOT_ID }))
    .toEqual({ ok: false, code: "CAPABILITY_OPERATION_MISMATCH" });
});

test("a token minted before a supervisor restart is refused", () => {
  const token = signCapability(CLAIMS, SECRET);
  expect(verifyCapability(token, SECRET, { operation: CLAIMS.operation, supervisorBootId: "boot-2" }))
    .toEqual({ ok: false, code: "CAPABILITY_BOOT_MISMATCH" });
});

test("the same token cannot be replayed a second time", () => {
  const token = signCapability(CLAIMS, SECRET);
  expect(verifyCapability(token, SECRET, { operation: CLAIMS.operation, supervisorBootId: BOOT_ID }).ok).toBe(true);
  expect(verifyCapability(token, SECRET, { operation: CLAIMS.operation, supervisorBootId: BOOT_ID }))
    .toEqual({ ok: false, code: "CAPABILITY_REPLAYED" });
});

test("two distinct tokens for the same operation both verify once each", () => {
  const first = signCapability(CLAIMS, SECRET);
  const second = signCapability(CLAIMS, SECRET);
  expect(verifyCapability(first, SECRET, { operation: CLAIMS.operation, supervisorBootId: BOOT_ID }).ok).toBe(true);
  expect(verifyCapability(second, SECRET, { operation: CLAIMS.operation, supervisorBootId: BOOT_ID }).ok).toBe(true);
});

describe("malformed tokens", () => {
  test.each([
    ["empty string", ""],
    ["no separator", "not-a-real-token"],
    ["unparseable payload", `${Buffer.from("not json").toString("base64url")}.deadbeef`]
  ])("%s is refused, not thrown", (_label, token) => {
    expect(() => verifyCapability(token, SECRET, { operation: CLAIMS.operation, supervisorBootId: BOOT_ID }))
      .not.toThrow();
    const result = verifyCapability(token || undefined, SECRET, { operation: CLAIMS.operation, supervisorBootId: BOOT_ID });
    expect(result.ok).toBe(false);
  });
});
