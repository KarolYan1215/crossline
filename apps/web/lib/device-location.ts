import "server-only";
import { DEVICE_LOCATION_CONSENT, DEVICE_LOCATION_SETTING, deviceReading, readDeviceLocation, type AccessContext, type DeviceLocation } from "@crossline/core";
import { appNow, getStore } from "./crossline";

/**
 * Device location (docs/opportunity-agent.md §17.6 a; the person's decision of 2026-11-02): its own consent, off by default. While it is on,
 * a page posts the device's position when the person presses the button; two decimals (about 1 km) and only the latest reading are kept,
 * never a track, and the worker names its town once. Turning it off deletes the reading.
 */
export const deviceLocationOn = (ctx: AccessContext) => getStore().getSetting(ctx.workspaceId, DEVICE_LOCATION_CONSENT) === "on";

export function deviceLocationState(ctx: AccessContext): { on: boolean; reading?: Pick<DeviceLocation, "at" | "city" | "country"> | undefined } {
  const on = deviceLocationOn(ctx);
  const reading = on ? readDeviceLocation(getStore().getSetting(ctx.workspaceId, DEVICE_LOCATION_SETTING)) : undefined;
  return { on, ...(reading ? { reading: { at: reading.at, city: reading.city, country: reading.country } } : {}) };
}

export function setDeviceLocationConsent(ctx: AccessContext, on: boolean): void {
  const store = getStore();
  store.setSetting(ctx.workspaceId, DEVICE_LOCATION_CONSENT, on ? "on" : "off");
  if (!on) store.deleteSetting(ctx.workspaceId, DEVICE_LOCATION_SETTING);
}

/** One reading, replacing the last; refused while the consent is off. A reading in the same ~1 km square keeps the town already named. */
export function recordDeviceLocation(ctx: AccessContext, lat: unknown, lon: unknown, now = appNow()): { ok: true } | { ok: false; code: string } {
  if (!deviceLocationOn(ctx)) return { ok: false, code: "DEVICE_LOCATION_NOT_ENABLED" };
  const reading = deviceReading(lat, lon, now.toISOString());
  if (!reading) return { ok: false, code: "DEVICE_LOCATION_INVALID" };
  const store = getStore();
  const last = readDeviceLocation(store.getSetting(ctx.workspaceId, DEVICE_LOCATION_SETTING));
  const same = last && last.lat === reading.lat && last.lon === reading.lon;
  store.setSetting(ctx.workspaceId, DEVICE_LOCATION_SETTING, JSON.stringify(same ? { ...reading, city: last.city, country: last.country } : reading));
  return { ok: true };
}
