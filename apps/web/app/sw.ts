/// <reference lib="webworker" />

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";
import { OPEN_HELPER_MESSAGE } from "./helper-pet";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST ?? [],
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: true,
  runtimeCaching: defaultCache,
  fallbacks: { entries: [{ url: "/offline", matcher: ({ request }) => request.destination === "document" }] }
});

serwist.addEventListeners();

// Push from this machine's worker (packages/connectors/src/web-push.ts): the morning brief and the single "would be missed today"
// messages, the same ones the desktop shows. The payload was encrypted for this device; the browser has already decrypted it.
self.addEventListener("push", (event) => {
  // `title` and `body` are written by the server in the account's language; `lang` names it, so the one button the service worker adds
  // itself is in that language too (else the browser's), without bundling the catalogues into the worker (docs/i18n.md).
  let message: { title?: string; body?: string; url?: string; tag?: string; start?: string; confirm?: string; lang?: string } = {};
  try { message = event.data?.json() ?? {}; } catch { message = { body: event.data?.text() ?? "" }; }
  event.waitUntil(self.registration.showNotification(message.title || "Crossline", {
    body: message.body ?? "", icon: "/pwa-icon/192", badge: "/pwa-icon/192",
    data: { url: message.url || "/", start: message.start, confirm: message.confirm }, ...(message.tag ? { tag: message.tag } : {}),
    ...(message.start ? { actions: [{ action: "start", title: startLabel(message.lang) }] }
      : message.confirm ? { actions: [{ action: "confirm_done", title: confirmLabel(message.lang, true) }, { action: "confirm_not_done", title: confirmLabel(message.lang, false) }] } : {})
  } as NotificationOptions));
});

function startLabel(lang: string | undefined): string {
  const english = lang ? lang.startsWith("en") : !(self.navigator.language ?? "zh").toLowerCase().startsWith("zh");
  return english ? "Start timer" : "开始计时";
}

/** The completion check's two answers on the notification itself (docs/plans/closed-loop-1030.md §2). */
function confirmLabel(lang: string | undefined, done: boolean): string {
  const english = lang ? lang.startsWith("en") : !(self.navigator.language ?? "zh").toLowerCase().startsWith("zh");
  return english ? (done ? "✓ Done" : "✗ Not done") : (done ? "✓ 做了" : "✗ 没做");
}

// Tapping it opens the page it is about, reusing an open Crossline window when there is one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: string; start?: string; confirm?: string } | undefined;
  const url = String(data?.url ?? "/");
  event.waitUntil((async () => {
    // ✓做了 / ✗没做 on a completion check: written here, same origin with the session cookie, and nothing opens — that is the point.
    if ((event.action === "confirm_done" || event.action === "confirm_not_done") && data?.confirm) {
      const form = new FormData();
      form.set("kind", event.action === "confirm_done" ? "as_planned" : "not_done");
      form.set("via", "push");
      await fetch(`/api/confirm/${encodeURIComponent(data.confirm)}`, { method: "POST", credentials: "include", body: form }).catch(() => undefined);
      return;
    }
    // 「开始计时」: started here, same origin with the session cookie, so the page that opens already shows the running timer.
    if (event.action === "start" && data?.start)
      await fetch(`/api/work-orders/${encodeURIComponent(data.start)}/execution`, { method: "POST", credentials: "include",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start" }) }).catch(() => undefined);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const target = new URL(url, self.location.origin);
    const open = windows.find((client) => new URL(client.url).origin === target.origin);
    // About the 小帮手: the window already open shows it in place (its widget opens the panel; `/helper` already is it), not a reload.
    if (open && target.pathname === "/helper") {
      await open.focus();
      if (new URL(open.url).pathname !== "/helper") open.postMessage({ type: OPEN_HELPER_MESSAGE });
      return;
    }
    if (open) { await open.focus(); await open.navigate(url).catch(() => undefined); return; }
    await self.clients.openWindow(url);
  })());
});
