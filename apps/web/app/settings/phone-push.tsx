"use client";

import { useEffect, useState } from "react";
import { useLocale, useT } from "../locale-context";

type Device = { device: string; origin: string; createdAt: string; endpointHost: string };

const toKey = (base64: string) => {
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};
/** The device's name as stored with its subscription, in the language the page was in when it was turned on. */
const deviceName = (t: (key: string) => string) => /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad"
  : /Android/.test(navigator.userAgent) ? t("Android 手机") : t("这台设备的浏览器");

/**
 * Turns on notifications for this device. An iPhone only allows it for the app added to the home screen and opened from there, and
 * only on the https (tailnet) address — each condition is said plainly instead of the button silently doing nothing.
 */
export function PhonePush() {
  const t = useT();
  const en = useLocale() === "en";
  const [devices, setDevices] = useState<Device[]>([]);
  const [status, setStatus] = useState("");
  const [blocker, setBlocker] = useState("");
  const load = async () => {
    const body = await fetch("/api/push", { cache: "no-store" }).then((r) => r.json()).catch(() => null) as { devices?: Device[] } | null;
    setDevices(body?.devices ?? []);
  };
  useEffect(() => {
    void load();
    const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
    if (location.protocol !== "https:") setBlocker(t("要在手机上用 https 的 Tailscale 地址打开这一页，才能开启推送。"));
    else if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
      setBlocker(/iPhone|iPad/.test(navigator.userAgent) && !standalone
        ? t("iPhone 只给添加到主屏幕的 App 推送：先点分享 →「添加到主屏幕」，再从主屏幕的图标打开这一页。")
        : t("这个浏览器不支持网页推送。"));
  }, []);

  const enable = async () => {
    setStatus(t("请求通知权限…"));
    try {
      if (await Notification.requestPermission() !== "granted") { setStatus(t("没有得到通知权限：可以在系统设置 → 通知 里给 Crossline 打开。")); return; }
      const { publicKey } = await fetch("/api/push", { cache: "no-store" }).then((r) => r.json()) as { publicKey: string };
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription()
        ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
      const response = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ subscription: subscription.toJSON(), origin: location.origin, device: deviceName(t) }) });
      setStatus(response.ok ? t("已开启。可以发一条测试推送看看。") : t("没保存上，请重试。"));
      await load();
    } catch (error) {
      setStatus(t("开启失败：{{reason}}", { reason: error instanceof Error ? error.message : t("未知原因") }));
    }
  };
  const test = async () => {
    setStatus(t("发送中…"));
    const result = await fetch("/api/push/test", { method: "POST" }).then((r) => r.json()).catch(() => null) as { sent?: number; gone?: number; failed?: number } | null;
    setStatus(result ? [t("已发出 {{count}} 条", { count: result.sent ?? 0 }), ...(result.gone ? [t("{{count}} 台设备已失效并移除", { count: result.gone })] : []),
      ...(result.failed ? [t("{{count}} 条失败", { count: result.failed })] : [])].join(en ? ", " : "，") + (en ? "." : "。") : t("发送失败。"));
    await load();
  };

  return <div className="phone-push">
    <p className="st-note">{t("早报与当日到期提醒同时推送到电脑和手机，档位与「通知」一致；内容在本机加密后经推送服务送达。")}</p>
    {devices.length > 0 && <ul>{devices.map((item) => <li key={item.createdAt}>{t("{{device}} · {{day}} 开启", { device: t(item.device), day: item.createdAt.slice(0, 10) })}</li>)}</ul>}
    {blocker ? <p className="muted">{blocker}</p>
      : <div className="execution-actions">
        <button type="button" className="primary-button" onClick={() => void enable()}>{t("在这台设备上开启推送")}</button>
        {devices.length > 0 && <button type="button" onClick={() => void test()}>{t("发一条测试推送")}</button>}
      </div>}
    {status && <small role="status">{status}</small>}
  </div>;
}
