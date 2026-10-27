import { readFileSync } from "node:fs";
import path from "node:path";
import { primaryOrigin } from "@crossline/core/device";

/**
 * Whether this install is a *device* of an account whose ledger is on the hosted site (docs/device-mode.md), and that site's address.
 * Read from `<data>/device/link.json`, which the worker writes when the person links this computer on `/device` (the token itself is a
 * DPAPI file only the worker reads). Kept tiny and free of the store on purpose: `proxy.ts` asks it on every page request, so it is
 * cached for fifteen seconds.
 */
export const DEVICE_LINK_FILE = ["device", "link.json"] as const;

const dataDir = () => process.env.CROSSLINE_DATA_DIR ? path.resolve(process.env.CROSSLINE_DATA_DIR) : path.resolve(process.cwd(), "../../data");
let cached: { at: number; dir: string; value: string | undefined } | undefined;

/** The primary site's origin when this install is a linked device, else undefined. */
export function devicePrimaryUrl(now = Date.now()): string | undefined {
  const dir = dataDir();
  if (cached && cached.dir === dir && now - cached.at < 15_000) return cached.value;
  let value: string | undefined;
  try {
    const link = JSON.parse(readFileSync(path.join(dir, ...DEVICE_LINK_FILE), "utf8")) as { url?: unknown };
    value = typeof link.url === "string" ? primaryOrigin(link.url) : undefined;
  } catch { value = undefined; }
  cached = { at: now, dir, value };
  return value;
}

/** Forgets the cached answer (after linking or unlinking from this app, and in tests). */
export function forgetDeviceLink(): void { cached = undefined; }

/** Paths that stay on this machine in device mode: the device page, signing in to reach it, and what pages load. */
export function staysLocal(pathname: string): boolean {
  return pathname === "/device" || pathname.startsWith("/device/") || pathname.startsWith("/login") || pathname.startsWith("/auth/")
    || pathname.startsWith("/api/") || pathname.startsWith("/_next/") || pathname === "/offline" || /\.[a-z0-9]+$/i.test(pathname)
    || pathname.startsWith("/pwa-icon") || pathname.startsWith("/apple-icon") || pathname.startsWith("/mediapipe");
}
