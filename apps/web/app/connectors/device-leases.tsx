"use client";
import { useEffect, useState } from "react";
import { deviceId as currentDeviceId } from "../offline-queue";

type DeviceLease = { deviceId: string; issuedAt: string; expiresAt: string; revokedAt?: string };

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

  const active = leases.filter((item) => !item.revokedAt);
  return <article className="status-card">
    <span className="status-badge">{active.length > 0 ? `${active.length} 台设备已授权离线` : "尚无离线设备"}</span>
    <h2>离线设备</h2>
    {leases.length === 0 && <p>还没有设备申请过离线租约。</p>}
    {leases.length > 0 && <ul>{leases.map((item) => <li key={item.deviceId}>
      {item.deviceId === mine ? "本机" : item.deviceId.slice(0, 8)}
      {item.revokedAt ? " · 已撤销" : ` · 到期 ${item.expiresAt.slice(0, 10)}`}
      {!item.revokedAt && <button type="button" onClick={() => void revoke(item.deviceId)}>撤销</button>}
    </li>)}</ul>}
    <details><summary>说明</summary><p>
      撤销只影响这台设备离线时能否把队列里的命令回放到账本——不会立刻让它的当前登录会话失效（那是账号安全设置的事），
      也不会清空它本地已缓存的数据。
    </p></details>
  </article>;
}
