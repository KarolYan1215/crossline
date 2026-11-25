import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APPLICATION_SLOTS, LOGIN_VAULT_SETTING, isSensitiveSlot, loginFor, loginHostOf, loginProblem, loginSecretName, normalForCompare, profilePlaceholder, readLoginVault, secretNameOf,
  type ApplicationSlot, type LoginSecret, type LoginVaultEntry } from "@crossline/core";
import type { SecretStore } from "@crossline/connectors";
import { applicationProfile, recordSensitiveSlot, saveProfileFact, removeProfileFact, type CrosslineStore } from "@crossline/db";
import type { ProfileValues } from "./form-engine";
import { vaultHash } from "./node/browser";
import type { NodeBrowserLink } from "./node/hub";

/**
 * The application profile's worker side (docs/opportunity-agent.md §12): a sensitive slot's value is written to and read from the
 * secret store only (`apply-<slot>`, the same DPAPI store the mail passwords live in), and its ledger record says only that it is held.
 * Nothing here logs a value; the engine gets them through `ProfileValues` and keeps them in memory for one run.
 */
export const hashForm = (value: string) => createHash("sha256").update(normalForCompare(value)).digest("hex");
const PHONE = /^[+()\d\s.-]{6,30}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Why a value cannot be kept for a slot, or undefined when it can. */
export function slotValueProblem(slot: ApplicationSlot, value: string): string | undefined {
  const text = value.trim();
  /* i18n-ignore-start: codes, translated where shown */
  if (!text) return "PROFILE_VALUE_EMPTY";
  if (text.length > 500) return "PROFILE_VALUE_TOO_LONG";
  if (slot === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return "PROFILE_EMAIL_INVALID";
  if (slot === "phone" && !PHONE.test(text)) return "PROFILE_PHONE_INVALID";
  if (slot === "birth_date" && !DATE.test(text)) return "PROFILE_DATE_INVALID";
  if ((slot === "website" || slot === "github") && !/^https:\/\/\S+$/.test(text)) return "PROFILE_URL_INVALID";
  /* i18n-ignore-end */
  return undefined;
}

/** The person confirmed a value (in settings, or answering a stopped run): sensitive to the secret store, the rest as a confirmed fact. */
export async function saveSlot(store: CrosslineStore, secrets: SecretStore, workspaceId: string, slot: ApplicationSlot, value: string, sourceRef: string): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!(slot in APPLICATION_SLOTS)) return { ok: false, code: "PROFILE_SLOT_UNKNOWN" };
  const problem = slotValueProblem(slot, value);
  if (problem) return { ok: false, code: problem };
  if (isSensitiveSlot(slot)) {
    try { await secrets.write(workspaceId, secretNameOf(slot), value.trim()); } catch { return { ok: false, code: "SECRET_STORE_UNAVAILABLE" }; }
    recordSensitiveSlot(store, workspaceId, slot, true);
  } else saveProfileFact(store, workspaceId, slot, value, sourceRef);
  return { ok: true };
}
export function removeSlot(store: CrosslineStore, secrets: SecretStore, workspaceId: string, slot: ApplicationSlot): boolean {
  if (!(slot in APPLICATION_SLOTS)) return false;
  if (isSensitiveSlot(slot)) { secrets.remove(workspaceId, secretNameOf(slot)); recordSensitiveSlot(store, workspaceId, slot, false); return true; }
  return removeProfileFact(store, workspaceId, slot);
}

/**
 * The values one run may use, read once: the ledger's confirmed facts and the sensitive slots. Where the sensitive ones are (§9.3 of
 * docs/plans/harness-1125.md): `here`, this worker's secret store (the machine owner's own computer with a screen); `computer`, the
 * person's computer the form opens on — the engine gets the placeholder, which that computer types as the value it holds and returns
 * in everything it reads back (node/browser.ts), so a value never reaches this worker; `nowhere`, a computer too old to hold them.
 */
export function profileValues(store: CrosslineStore, secrets: SecretStore, workspaceId: string, sensitiveAt: "here" | "computer" | "nowhere" = "here"): ProfileValues {
  const items = applicationProfile(store, workspaceId);
  const present = new Set(items.filter((item) => item.present).map((item) => item.slot));
  const cache = new Map<ApplicationSlot, Promise<string | undefined>>();
  const sensitive = (slot: ApplicationSlot): Promise<string | undefined> => !present.has(slot) || sensitiveAt === "nowhere" ? Promise.resolve(undefined)
    : sensitiveAt === "computer" ? Promise.resolve(profilePlaceholder(slot)) : secrets.read(workspaceId, secretNameOf(slot)).catch(() => undefined);
  const get = (slot: ApplicationSlot) => {
    if (!cache.has(slot)) cache.set(slot, isSensitiveSlot(slot) ? sensitive(slot)
      : Promise.resolve(items.find((item) => item.slot === slot)?.value));
    return cache.get(slot)!;
  };
  return {
    present, get,
    sensitive: async () => {
      const held: Array<{ slot: ApplicationSlot; value: string }> = [];
      for (const slot of present) if (isSensitiveSlot(slot)) { const value = await get(slot); if (value) held.push({ slot, value }); }
      return held;
    },
    file: async (slot) => {
      const value = await get(slot);
      if (!value) return undefined;
      // The résumé is one of the person's uploaded files, by id; a path is accepted only when it exists.
      const doc = store.listSourceDocuments(workspaceId).find((item) => item.id === value);
      const file = doc ? (doc.uri.startsWith("file:") ? fileURLToPath(doc.uri) : doc.uri) : value;
      return existsSync(file) ? file : undefined;
    }
  };
}

// ———————————————————————————————————————— sensitive items on the person's computer (docs/plans/harness-1125.md §9.3)

/** The computer that holds an account's sensitive items: a connected node whose `hello` said `vault`. */
export type VaultLink = Pick<NodeBrowserLink, "host" | "call" | "vault">;
/** The sensitive slots the ledger says are held (wherever they are). */
export const heldSensitiveSlots = (store: CrosslineStore, workspaceId: string): ApplicationSlot[] =>
  applicationProfile(store, workspaceId).filter((item) => item.present && isSensitiveSlot(item.slot)).map((item) => item.slot);

/** Saves a value in the computer's secret store and checks the hash of what reads back there; true only when it matches. */
async function putOnComputer(link: VaultLink, slot: ApplicationSlot, value: string): Promise<boolean> {
  if (!link.vault) return false;
  const answer = await link.call({ op: "vaultPut", slot, value }, 60_000).catch(() => undefined) as { sha256?: unknown } | null | undefined;
  return typeof answer?.sha256 === "string" && answer.sha256 === vaultHash(value);
}

/**
 * The person saved an item for an account whose forms open on their computer: a sensitive one goes to that computer's secret store
 * only, through the node's connection (in this worker's memory for the call, never written, logged or answered back), and is recorded
 * here as held only once the computer's hash of it matches. Any older copy in this worker's store goes then. No computer connected, or
 * one that cannot hold it: refused, nothing changed.
 */
export async function saveSlotOnComputer(store: CrosslineStore, secrets: SecretStore, workspaceId: string, slot: ApplicationSlot, value: string, sourceRef: string,
  link: VaultLink | undefined): Promise<{ ok: true } | { ok: false; code: string }> {
  if (!(slot in APPLICATION_SLOTS)) return { ok: false, code: "PROFILE_SLOT_UNKNOWN" };
  if (!isSensitiveSlot(slot)) return saveSlot(store, secrets, workspaceId, slot, value, sourceRef);
  const problem = slotValueProblem(slot, value);
  if (problem) return { ok: false, code: problem };
  if (!link?.vault) return { ok: false, code: "SENSITIVE_NEEDS_COMPUTER" };
  if (!await putOnComputer(link, slot, value.trim())) return { ok: false, code: "SENSITIVE_VERIFY_FAILED" };
  secrets.remove(workspaceId, secretNameOf(slot));
  recordSensitiveSlot(store, workspaceId, slot, true);
  return { ok: true };
}

/** Removing a sensitive item held on the computer: there first (it must be connected), then any older copy here, then the record. */
export async function removeSlotOnComputer(store: CrosslineStore, secrets: SecretStore, workspaceId: string, slot: ApplicationSlot,
  link: VaultLink | undefined): Promise<{ ok: boolean; code?: string }> {
  if (!(slot in APPLICATION_SLOTS)) return { ok: false };
  if (!isSensitiveSlot(slot)) return { ok: removeProfileFact(store, workspaceId, slot) };
  if (!link?.vault) return { ok: false, code: "SENSITIVE_NEEDS_COMPUTER" };
  const removed = await link.call({ op: "vaultRemove", slot }, 60_000).then(() => true, () => false);
  if (!removed) return { ok: false, code: "SENSITIVE_NEEDS_COMPUTER" };
  secrets.remove(workspaceId, secretNameOf(slot));
  recordSensitiveSlot(store, workspaceId, slot, false);
  return { ok: true };
}

/**
 * Moving the copies this worker still holds to the computer (the owner's decision of 2026-11-25): each held item found in this
 * worker's store is saved on the computer, and only when the computer's hash of what it reads back matches is this copy deleted — a
 * deletion that cannot be undone, so a mismatch, an error or a missing answer keeps it for the next try. The ledger's record (held)
 * does not change; the move is one `apply.profile.saved` event with `movedToComputer`. Nothing here logs or records a value.
 */
export async function moveSensitiveToComputer(store: CrosslineStore, secrets: SecretStore, workspaceId: string, link: VaultLink,
  log: (event: Record<string, unknown>) => void = () => undefined): Promise<{ moved: ApplicationSlot[]; kept: ApplicationSlot[] }> {
  const moved: ApplicationSlot[] = [];
  const kept: ApplicationSlot[] = [];
  if (!link.vault) return { moved, kept };
  for (const slot of heldSensitiveSlots(store, workspaceId)) {
    const value = await secrets.read(workspaceId, secretNameOf(slot)).catch(() => undefined);
    if (!value) continue;
    if (!await putOnComputer(link, slot, value)) { kept.push(slot); log({ event: "apply.sensitive.move_failed", workspaceId, slot, node: link.host }); continue; }
    secrets.remove(workspaceId, secretNameOf(slot));
    moved.push(slot);
    store.appendEvent({ ownerId: store.getWorkspaceOwnerId(workspaceId) ?? "system", workspaceId, type: "apply.profile.saved", entityId: slot,
      idempotencyKey: `apply.profile.moved:${slot}:${Date.now()}:${randomUUID().slice(0, 8)}`, payload: { slot, sensitive: true, movedToComputer: link.host } });
    log({ event: "apply.sensitive.moved", workspaceId, slot, node: link.host });
  }
  return { moved, kept };
}

// ———————————————————————————————————————— saved website logins (docs/plans/harness-1125.md §5)

/** The ledger's record: which hosts hold a login in the secret store, and since when. Never a username or password. */
export const loginVault = (store: CrosslineStore, workspaceId: string): LoginVaultEntry[] => readLoginVault(store.getSetting(workspaceId, LOGIN_VAULT_SETTING));
const writeVault = (store: CrosslineStore, workspaceId: string, entries: LoginVaultEntry[], host: string, saved: boolean) => {
  store.setSetting(workspaceId, LOGIN_VAULT_SETTING, JSON.stringify(entries));
  // The profile's own events, with the host as the only detail.
  store.appendEvent({ ownerId: store.getWorkspaceOwnerId(workspaceId) ?? "system", workspaceId, type: saved ? "apply.profile.saved" : "apply.profile.removed",
    entityId: `login:${host}`, idempotencyKey: `apply.login:${host}:${Date.now()}:${randomUUID().slice(0, 8)}`, payload: { login: host, sensitive: true } });
};

/** The person saved a login: username and password together in the secret store (`login-<host>`), the host alone in the ledger. */
export async function saveLogin(store: CrosslineStore, secrets: SecretStore, workspaceId: string, input: { host: string; username: string; password: string }): Promise<{ ok: true; host: string } | { ok: false; code: string }> {
  const problem = loginProblem(input);
  const host = loginHostOf(input.host);
  if (problem || !host) return { ok: false, code: problem ?? "LOGIN_HOST_INVALID" };
  const secret: LoginSecret = { username: input.username.trim(), password: input.password };
  try { await secrets.write(workspaceId, loginSecretName(host), JSON.stringify(secret)); } catch { return { ok: false, code: "SECRET_STORE_UNAVAILABLE" }; }
  writeVault(store, workspaceId, [...loginVault(store, workspaceId).filter((entry) => entry.host !== host), { host, savedAt: new Date().toISOString() }], host, true);
  return { ok: true, host };
}
export function removeLogin(store: CrosslineStore, secrets: SecretStore, workspaceId: string, hostInput: string): boolean {
  const host = loginHostOf(hostInput);
  if (!host) return false;
  secrets.remove(workspaceId, loginSecretName(host));
  const entries = loginVault(store, workspaceId);
  if (!entries.some((entry) => entry.host === host)) return false;
  writeVault(store, workspaceId, entries.filter((entry) => entry.host !== host), host, false);
  return true;
}

/**
 * The engine's view of the vault for one run: whether a page's address has a saved login (`loginFor`: https, the exact host or a
 * known alias), and the login itself, read from the secret store only when the engine is about to type it.
 */
export function savedLogins(store: CrosslineStore, secrets: SecretStore, workspaceId: string, aliases: (host: string) => string[]) {
  const entries = loginVault(store, workspaceId);
  return {
    has: (url: string) => Boolean(loginFor(entries, url, aliases)),
    get: async (url: string): Promise<(LoginSecret & { host: string }) | undefined> => {
      const entry = loginFor(entries, url, aliases);
      if (!entry) return undefined;
      const raw = await secrets.read(workspaceId, loginSecretName(entry.host)).catch(() => undefined);
      try {
        const parsed = JSON.parse(raw ?? "") as Partial<LoginSecret>;
        return typeof parsed.username === "string" && typeof parsed.password === "string" && parsed.password ? { host: entry.host, username: parsed.username, password: parsed.password } : undefined;
      } catch { return undefined; }
    }
  };
}
