import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APPLICATION_SLOTS, isSensitiveSlot, normalForCompare, secretNameOf, type ApplicationSlot } from "@crossline/core";
import type { SecretStore } from "@crossline/connectors";
import { applicationProfile, recordSensitiveSlot, saveProfileFact, removeProfileFact, type CrosslineStore } from "@crossline/db";
import type { ProfileValues } from "./form-engine";

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

/** The values one run may use, read once: the ledger's confirmed facts and the secret store's sensitive slots. */
export function profileValues(store: CrosslineStore, secrets: SecretStore, workspaceId: string): ProfileValues {
  const items = applicationProfile(store, workspaceId);
  const present = new Set(items.filter((item) => item.present).map((item) => item.slot));
  const cache = new Map<ApplicationSlot, Promise<string | undefined>>();
  const get = (slot: ApplicationSlot) => {
    if (!cache.has(slot)) cache.set(slot, isSensitiveSlot(slot)
      ? (present.has(slot) ? secrets.read(workspaceId, secretNameOf(slot)).catch(() => undefined) : Promise.resolve(undefined))
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
