/// <reference lib="webworker" />

import { defaultCache } from "@serwist/next/worker";
import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist } from "serwist";

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
  let message: { title?: string; body?: string; url?: string; tag?: string } = {};
  try { message = event.data?.json() ?? {}; } catch { message = { body: event.data?.text() ?? "" }; }
  event.waitUntil(self.registration.showNotification(message.title || "Crossline", {
    body: message.body ?? "", icon: "/pwa-icon/192", badge: "/pwa-icon/192",
    data: { url: message.url || "/" }, ...(message.tag ? { tag: message.tag } : {})
  }));
});

// Tapping it opens the page it is about, reusing an open Crossline window when there is one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = String((event.notification.data as { url?: string } | undefined)?.url ?? "/");
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === new URL(url, self.location.origin).origin);
    if (open) { await open.focus(); await open.navigate(url).catch(() => undefined); return; }
    await self.clients.openWindow(url);
  })());
});
