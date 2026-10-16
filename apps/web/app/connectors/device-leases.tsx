"use client";
import { useEffect, useState } from "react";
import { deviceId as currentDeviceId } from "../offline-queue";

type DeviceLease = { deviceId: string; issuedAt: string; expiresAt: string; revokedAt?: string };

/** How many offline devices are listed before the rest fold. */
const LEASES_SHOWN = 5;

/**
 * `issueDeviceLease` (`apps/web/app/api/auth/device-lease/route.ts`) had no reader and no revoke UI
 * until now — a lost or stolen device's offline lease could be revoked at the store layer
 * (`revokeDeviceLease` already existed, tested) but nothing in the app could ever call it. This card is
 * that missing surface: list every device this workspace has leased, let the owner revoke one.
 */
export function DeviceLeases() {
  const [leases, setLeases] = useState<DeviceLease[]>([]);
  const [mine, setMine] = useState("");

  const refresh = async () => {
    const response = await fetch("/api/auth/device-lease").catch(() => undefined);
    if (!response?.ok) return;
    const body = await response.json() as { leases: DeviceLease[] };
    setLeases(body.leases);
  };
  useEffect(() => { setMine(currentDeviceId()); void refresh(); }, []);

  const revoke = async (deviceId: string) => {
    await fetch("/api/auth/device-lease", {
      method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceId })
    });
    void refresh();
  };

  // An expired lease is already dead: it was listed with a 撤销 button that could do nothing, ten devices long on the real account.
  const current = leases.filter((item) => item.expiresAt > new Date().toISOString());
  const leaseItem = (item: (typeof current)[number]) => <li key={item.deviceId}>
    <span>{item.deviceId === mine ? "本机" : `设备 ${current.indexOf(item) + 1}`}</span>
    <small>{item.revokedAt ? "已撤销" : `有效至 ${item.expiresAt.slice(0, 10)}`}</small>
    {!item.revokedAt && <button type="button" onClick={() => void revoke(item.deviceId)}>撤销</button>}
  </li>;
  return <section className="st-card" aria-label="离线设备">
    <header><h3>离线设备</h3><small>撤销后，该设备离线期间的操作不再写入；不影响其登录</small></header>
    {current.length === 0 && <p className="muted">尚无设备开启离线同步。</p>}
    {/* The first few in view; a browser that re-leases on every visit can hold a dozen, folded below. */}
    {current.length > 0 && <ul className="st-list">{current.slice(0, LEASES_SHOWN).map(leaseItem)}</ul>}
    {current.length > LEASES_SHOWN && <details className="fold advanced"><summary>其余 {current.length - LEASES_SHOWN} 台</summary>
      <ul className="st-list">{current.slice(LEASES_SHOWN).map(leaseItem)}</ul></details>}
  </section>;
}
