"use client";

import { useEffect } from "react";

const SENT = "crossline:time-zone-sent";

/**
 * Tells the server which zone this device is in (`syncDeviceTimeZone`), once per tab session or when the device's zone changes, and
 * reloads the page's data when that moved the person's day: the hosted server's own zone is not the person's.
 */
export function TimeZoneSync() {
  useEffect(() => {
    let zone = "";
    try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""; } catch { return; }
    if (!zone) return;
    try { if (sessionStorage.getItem(SENT) === zone) return; } catch { /* storage blocked: send anyway */ }
    void fetch("/api/settings/time-zone", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ timeZone: zone }) })
      .then((response) => response.json() as Promise<{ ok?: boolean; changed?: boolean }>)
      .then((body) => {
        if (!body.ok) return;
        try { sessionStorage.setItem(SENT, zone); } catch { /* fine */ }
        if (body.changed) location.reload();
      }).catch(() => {});
  }, []);
  return null;
}
