import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { proxy } from "../proxy";
import { devicePrimaryUrl, forgetDeviceLink, staysLocal } from "./device-mode";

let data: string;
beforeEach(() => { data = mkdtempSync(path.join(tmpdir(), "crossline-device-mode-")); vi.stubEnv("CROSSLINE_DATA_DIR", data); forgetDeviceLink(); });
afterEach(() => { vi.unstubAllEnvs(); forgetDeviceLink(); rmSync(data, { recursive: true, force: true }); });

const link = (url: string) => { mkdirSync(path.join(data, "device"), { recursive: true }); writeFileSync(path.join(data, "device", "link.json"), JSON.stringify({ url })); forgetDeviceLink(); };
const visit = (pathname: string) => proxy(new NextRequest(new URL(pathname, "http://127.0.0.1:3210")));

test("unlinked, every page stays here", () => {
  expect(devicePrimaryUrl()).toBeUndefined();
  expect(visit("/plan?horizon=4").headers.get("location")).toBeNull();
});

test("linked as a device, every page opens the hosted site with its path and query, except the device page, signing in and the API", () => {
  link("https://app.crossline.lol/settings");
  expect(devicePrimaryUrl()).toBe("https://app.crossline.lol");
  const plan = visit("/plan?horizon=4");
  expect(plan.status).toBe(307);
  expect(plan.headers.get("location")).toBe("https://app.crossline.lol/plan?horizon=4");
  expect(visit("/").headers.get("location")).toBe("https://app.crossline.lol/");
  for (const local of ["/device", "/login", "/api/device/link", "/_next/static/x.js", "/manifest.webmanifest"]) {
    expect(staysLocal(local), local).toBe(true);
    expect(visit(local).headers.get("location"), local).toBeNull();
  }
});

test("an address that is not https (or this machine) is not followed", () => {
  link("http://evil.example");
  expect(devicePrimaryUrl()).toBeUndefined();
  expect(visit("/").headers.get("location")).toBeNull();
});
