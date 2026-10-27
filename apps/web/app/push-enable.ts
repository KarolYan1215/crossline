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

/** A step that does not answer within `ms` ends with `stuck` said, instead of the page waiting on it for ever. */
function within<T>(work: Promise<T>, ms: number, stuck: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(stuck)), ms);
    work.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

/**
 * Turns on notifications for this device (from a click: browsers ask for the permission only then); says each step as it goes (`onStep`)
 * and how it went. Each step has a time limit: an iPhone that never showed the permission question, or a page whose offline worker never
 * finished installing, used to leave the button on 「请求通知权限…」 for ever (2026-10-24).
 */
export async function enablePush(onStep: (step: string) => void = () => {}): Promise<{ ok: boolean; message: string }> {
  const blocked = pushBlocker();
  if (blocked) return { ok: false, message: blocked };
  try {
    if (Notification.permission === "denied") return { ok: false, message: "通知已被拒绝：到系统设置 → 通知 → Crossline 打开「允许通知」，再点一次。" };
    onStep("请求通知权限…（系统会问是否允许，点「允许」）");
    const permission = await within(Notification.requestPermission(), 60_000,
      "系统没有弹出权限询问：到系统设置 → 通知 → Crossline 打开「允许通知」，再回来点一次。");
    if (permission !== "granted") return { ok: false, message: "没有得到通知权限：可以在系统设置 → 通知 里给 Crossline 打开。" };
    onStep("已允许，正在准备后台服务…");
    // The page's offline worker receives the notifications; one not registered yet is registered here.
    if (!(await navigator.serviceWorker.getRegistration())) await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    const registration = await within(navigator.serviceWorker.ready, 30_000,
      "后台服务还没装好：把 Crossline 从后台划掉，再从主屏幕图标打开，等十几秒后再点一次。");
    onStep("正在向推送服务登记这台设备…");
    const { publicKey } = await fetch("/api/push", { cache: "no-store" }).then((r) => r.json()) as { publicKey: string };
    const subscription = await within(registration.pushManager.getSubscription(), 20_000, "推送服务没有回应，稍后再试。")
      ?? await within(registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) }), 30_000,
        "推送服务没有回应（Apple 或 Google 的推送服务连不上），检查网络后再试。");
    const response = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: subscription.toJSON(), origin: location.origin, device: deviceName() }) });
    return response.ok ? { ok: true, message: "已开启。可以发一条测试推送看看。" } : { ok: false, message: "没保存上，请重试。" };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "开启失败：未知原因" };
  }
}
