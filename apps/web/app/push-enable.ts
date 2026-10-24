"use client";

const toKey = (base64: string) => {
  const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
};
const deviceName = () => /iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad"
  : /Android/.test(navigator.userAgent) ? "Android 手机" : "这台设备的浏览器";

/** Why this device cannot take notifications, in words, or undefined when it can. */
export function pushBlocker(): string | undefined {
  const standalone = window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
  if (location.protocol !== "https:") return "要用 https 地址打开这一页，才能开启推送。";
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return /iPhone|iPad/.test(navigator.userAgent) && !standalone
      ? "iPhone 只给添加到主屏幕的 App 推送：先点分享 →「添加到主屏幕」，再从主屏幕的图标打开这一页。"
      : "这个浏览器不支持网页推送。";
  return undefined;
}

/** Turns on notifications for this device (from a click: browsers ask for the permission only then); says how it went. */
export async function enablePush(): Promise<{ ok: boolean; message: string }> {
  const blocked = pushBlocker();
  if (blocked) return { ok: false, message: blocked };
  try {
    if (await Notification.requestPermission() !== "granted") return { ok: false, message: "没有得到通知权限：可以在系统设置 → 通知 里给 Crossline 打开。" };
    const { publicKey } = await fetch("/api/push", { cache: "no-store" }).then((r) => r.json()) as { publicKey: string };
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription()
      ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
    const response = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON(), origin: location.origin, device: deviceName() }) });
    return response.ok ? { ok: true, message: "已开启。可以发一条测试推送看看。" } : { ok: false, message: "没保存上，请重试。" };
  } catch (error) {
    return { ok: false, message: `开启失败：${error instanceof Error ? error.message : "未知原因"}` };
  }
}
