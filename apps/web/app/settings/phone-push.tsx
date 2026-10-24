"use client";

import { useEffect, useState } from "react";
import { SetupGuide } from "../ui/setup-guide";
import { phonePushGuide } from "../../lib/setup-guides";
import { enablePush, pushBlocker } from "../push-enable";

type Device = { device: string; origin: string; createdAt: string; endpointHost: string };

/**
 * Turns on notifications for this device. An iPhone only allows it for the app added to the home screen and opened from there, and
 * only on the https (tailnet) address — each condition is said plainly instead of the button silently doing nothing.
 */
export function PhonePush({ privateNetwork = true }: { privateNetwork?: boolean } = {}) {
  const [devices, setDevices] = useState<Device[]>([]);
  const [status, setStatus] = useState("");
  const [blocker, setBlocker] = useState("");
  // The guide opens on the tab for the device the page is open on.
  const [device, setDevice] = useState<string | undefined>();
  const load = async () => {
    const body = await fetch("/api/push", { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { devices?: Device[] } | null;
    setDevices(body?.devices ?? []);
  };
  useEffect(() => {
    void load();
    setDevice(/iPhone|iPad/.test(navigator.userAgent) ? "iphone" : /Android/.test(navigator.userAgent) ? "android" : "desktop");
    const blocked = pushBlocker();
    if (blocked) setBlocker(blocked);
  }, []);

  const enable = async () => {
    setStatus((await enablePush(setStatus)).message);
    await load();
  };
  const test = async () => {
    setStatus("发送中…");
    const result = await fetch("/api/push/test", { method: "POST" }).then((r) => r.json()).catch(() => null) as { sent?: number; gone?: number; failed?: number } | null;
    setStatus(result ? `已发出 ${result.sent ?? 0} 条${result.gone ? `，${result.gone} 台设备已失效并移除` : ""}${result.failed ? `，${result.failed} 条失败` : ""}。` : "发送失败。");
    await load();
  };

  return <div className="phone-push">
    <p className="st-note">早报与当日到期提醒同时推送到电脑和手机，档位与「通知」一致；内容在本机加密后经推送服务送达。</p>
    {devices.length > 0 && <ul>{devices.map((item) => <li key={item.createdAt}>{item.device} · {item.createdAt.slice(0, 10)} 开启</li>)}</ul>}
    {blocker ? <p className="muted">{blocker}</p>
      : <div className="execution-actions">
        <button type="button" className="primary-button" onClick={() => void enable()}>在这台设备上开启推送</button>
        {devices.length > 0 && <button type="button" onClick={() => void test()}>发一条测试推送</button>}
      </div>}
    {status && <small role="status">{status}</small>}
    <SetupGuide guide={phonePushGuide(privateNetwork)} selected={device} />
  </div>;
}
