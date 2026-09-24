import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore, isDeviceLeaseValid, type StoredDeviceLease } from "./index";

let store: CrosslineStore;
beforeEach(() => { store = new CrosslineStore(":memory:"); });
afterEach(() => store.close());

test("issuing a lease for a new device stores it, readable back by workspace and device", () => {
  const lease = store.issueDeviceLease({
    id: "lease-1", principalId: "p1", workspaceId: "w1", deviceId: "device-1",
    issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z"
  });
  expect(lease).toMatchObject({ deviceId: "device-1", workspaceId: "w1" });
  expect(store.getDeviceLease("w1", "device-1")).toMatchObject({ principalId: "p1", expiresAt: "2026-01-02T00:00:00.000Z" });
  expect(store.getDeviceLease("w1", "device-1")?.revokedAt).toBeUndefined();
});

test("re-issuing for the same device renews it in place instead of accumulating rows", () => {
  store.issueDeviceLease({ id: "lease-1", principalId: "p1", workspaceId: "w1", deviceId: "device-1",
    issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" });
  store.issueDeviceLease({ id: "lease-2", principalId: "p1", workspaceId: "w1", deviceId: "device-1",
    issuedAt: "2026-01-02T00:00:00.000Z", expiresAt: "2026-01-03T00:00:00.000Z" });
  expect(store.getDeviceLease("w1", "device-1")).toMatchObject({ id: "lease-2", expiresAt: "2026-01-03T00:00:00.000Z" });
});

test("the same device id in a different workspace is a distinct lease", () => {
  store.issueDeviceLease({ id: "lease-1", principalId: "p1", workspaceId: "w1", deviceId: "device-1",
    issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" });
  expect(store.getDeviceLease("w2", "device-1")).toBeUndefined();
});

test("revoking a lease stamps revokedAt, and a second revoke is a no-op rather than an error", () => {
  store.issueDeviceLease({ id: "lease-1", principalId: "p1", workspaceId: "w1", deviceId: "device-1",
    issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" });
  expect(store.revokeDeviceLease("w1", "device-1")).toEqual({ changed: true });
  expect(store.getDeviceLease("w1", "device-1")?.revokedAt).toBeDefined();
  expect(store.revokeDeviceLease("w1", "device-1")).toEqual({ changed: false });
});

test("re-issuing a revoked device's lease clears the revocation", () => {
  store.issueDeviceLease({ id: "lease-1", principalId: "p1", workspaceId: "w1", deviceId: "device-1",
    issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" });
  store.revokeDeviceLease("w1", "device-1");
  store.issueDeviceLease({ id: "lease-2", principalId: "p1", workspaceId: "w1", deviceId: "device-1",
    issuedAt: "2026-01-03T00:00:00.000Z", expiresAt: "2026-01-04T00:00:00.000Z" });
  expect(store.getDeviceLease("w1", "device-1")?.revokedAt).toBeUndefined();
});

test("isDeviceLeaseValid judges strictly from its own timestamps, not the store", () => {
  const base: StoredDeviceLease = { id: "lease-1", principalId: "p1", workspaceId: "w1", deviceId: "device-1",
    issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-02T00:00:00.000Z" };
  expect(isDeviceLeaseValid(base, new Date("2026-01-01T12:00:00.000Z"))).toBe(true);
  // The boundary itself is not valid: "expires at" means unusable from that instant on.
  expect(isDeviceLeaseValid(base, new Date("2026-01-02T00:00:00.000Z"))).toBe(false);
  expect(isDeviceLeaseValid(base, new Date("2026-01-03T00:00:00.000Z"))).toBe(false);
  expect(isDeviceLeaseValid({ ...base, revokedAt: "2026-01-01T06:00:00.000Z" }, new Date("2026-01-01T12:00:00.000Z"))).toBe(false);
});
