"use client";

import { fingerprintOf, newEnvelope, signEnvelope, toBase64, type RemoteKind, type SignedRemote } from "@crossline/core/remote-control";

/**
 * This phone's key for remote control (docs/plans/remote-control-1122.md §5.1): an ECDSA P-256 pair made in the browser, the private half
 * not extractable, kept in this site's IndexedDB. It never leaves the phone; the computer holds the public half once the person confirmed
 * its fingerprint on the computer's own screen. Clearing the site's data loses it, and the phone is paired again.
 */
export type PhoneKey = { id: string; groups: string; publicKey: string; privateKey: CryptoKey; createdAt: string };

const DB = "crossline-remote";
const STORE = "keys";
const KEY = "phone";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(STORE); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IDB_FAILED"));
  });
}
async function inStore<T>(mode: IDBTransactionMode, act: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const db = await database();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = act(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error("IDB_FAILED"));
    });
  } finally { db.close(); }
}

/** Whether this browser can hold a key at all (WebCrypto needs a secure origin). */
export const remoteKeySupported = () => typeof indexedDB !== "undefined" && Boolean(globalThis.crypto?.subtle) && globalThis.isSecureContext !== false;

export async function readPhoneKey(): Promise<PhoneKey | undefined> {
  try { return await inStore<PhoneKey | undefined>("readonly", (store) => store.get(KEY)) ?? undefined; } catch { return undefined; }
}

/** The key this phone signs with, made the first time it is asked for. */
export async function phoneKey(): Promise<PhoneKey> {
  const kept = await readPhoneKey();
  if (kept) return kept;
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const publicKey = toBase64(new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey)));
  const print = await fingerprintOf(publicKey);
  const key: PhoneKey = { id: print.id, groups: print.groups, publicKey, privateKey: pair.privateKey, createdAt: new Date().toISOString() };
  await inStore("readwrite", (store) => store.put(key, KEY));
  return key;
}

export async function forgetPhoneKey(): Promise<void> {
  try { await inStore("readwrite", (store) => store.delete(KEY)); } catch { /* nothing kept */ }
}

/** One instruction for a computer, signed here. */
export async function signRemote(input: { kind: RemoteKind; computer: string; session?: string; payload: Record<string, unknown> }): Promise<SignedRemote> {
  const key = await readPhoneKey();
  if (!key) throw new Error("REMOTE_NO_KEY");
  return signEnvelope(key.privateKey, key.id, newEnvelope(input));
}

/** The SHA-256 of a command as the computer computes it (an approval signs this, so a swapped command is refused). */
export async function commandSha(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
