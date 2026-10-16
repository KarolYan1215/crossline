import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import webpush from "web-push";

/**
 * Notifications on the person's phone, through the platform's own push service (Apple's for an iPhone home-screen app).
 *
 * The person chose this on 2026-10-07, and it is the one outbound path the notifications have: a message for their own device,
 * nothing else. What travels is encrypted for that device (RFC 8291, `aes128gcm`) before it leaves this machine, so the push service
 * relays bytes it cannot read; the request is signed with this install's VAPID key (RFC 8292), which never leaves the data directory.
 *
 * The server only ever posts to a known push service: a subscription arrives from a browser, and an endpoint is a URL — accepting any
 * would let anything that can write a subscription make this machine send requests wherever it likes.
 */
export type PushSubscriptionRecord = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Where the page that subscribed was opened from (the tailnet address): a notification opens a page there. */
  origin: string;
  /** What the person's browser said it is, so the settings page can name the device. */
  device: string;
  createdAt: string;
};
export type VapidKeys = { publicKey: string; privateKey: string };
/** `start`: a work order the notification can start timing with one tap (its 「开始计时」 action), without opening the app first. */
/** `lang` names the language `title` and `body` are written in (the account's), so the service worker's own button matches it. */
export type PushMessage = { title: string; body: string; path: string; tag?: string; start?: string; lang?: string };

const PUSH_HOSTS = [/^web\.push\.apple\.com$/, /^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /\.notify\.windows\.com$/];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.port && PUSH_HOSTS.some((host) => host.test(url.hostname));
  } catch { return false; }
}

/** The structural check a subscription has to pass before it is stored: a known push service and the two keys it encrypts with. */
export function validPushSubscription(value: unknown): value is { endpoint: string; keys: { p256dh: string; auth: string } } {
  const sub = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
  return typeof sub?.endpoint === "string" && sub.endpoint.length <= 1024 && isAllowedPushEndpoint(sub.endpoint)
    && typeof sub.keys?.p256dh === "string" && /^[A-Za-z0-9_-]{40,200}$/.test(sub.keys.p256dh)
    && typeof sub.keys?.auth === "string" && /^[A-Za-z0-9_-]{10,60}$/.test(sub.keys.auth);
}

/** This install's VAPID key pair, made on first use and kept beside the ledger (never in it, so an export does not carry it). */
export function loadVapidKeys(dataDir: string): VapidKeys {
  const file = path.join(dataDir, "push-vapid.json");
  if (existsSync(file)) {
    const keys = JSON.parse(readFileSync(file, "utf8")) as VapidKeys;
    if (keys.publicKey && keys.privateKey) return keys;
  }
  mkdirSync(dataDir, { recursive: true });
  const keys = webpush.generateVAPIDKeys();
  writeFileSync(file, JSON.stringify(keys), { encoding: "utf8", mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows: the file sits in the user's own profile */ }
  return keys;
}

/**
 * Sends one message to one device. `gone` means the push service says the subscription no longer exists (the app was removed, or
 * notifications were turned off): the caller drops it rather than trying it again every two minutes.
 */
export async function sendWebPush(subscription: PushSubscriptionRecord, message: PushMessage, keys: VapidKeys,
  send: typeof webpush.sendNotification = webpush.sendNotification): Promise<"sent" | "gone" | "failed"> {
  if (!isAllowedPushEndpoint(subscription.endpoint)) return "failed";
  const payload = JSON.stringify({ title: message.title.slice(0, 120), body: message.body.slice(0, 300),
    url: `${subscription.origin}${message.path}`, ...(message.tag ? { tag: message.tag } : {}), ...(message.start ? { start: message.start } : {}),
    ...(message.lang ? { lang: message.lang } : {}) });
  try {
    await send({ endpoint: subscription.endpoint, keys: subscription.keys }, payload, {
      vapidDetails: { subject: subscription.origin.startsWith("https://") ? subscription.origin : "mailto:crossline@localhost", ...keys },
      TTL: 6 * 3600, urgency: "high", timeout: 15_000
    });
    return "sent";
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode;
    return status === 404 || status === 410 ? "gone" : "failed";
  }
}
