import {
  APPLICATION_SLOTS, FORM_RUNS_SETTING, SENSITIVE_PROFILE_SETTING, applySlotFact, assembleProfile, isSensitiveSlot,
  type ApplicationSlot, type Opportunity, type ProfileItem, type StoredFormRun
} from "@crossline/core";
import { randomUUID } from "node:crypto";
import type { CrosslineStore } from "./index";

/**
 * The form filling's ledger side (docs/opportunity-agent.md §10–§12), shared by the worker that fills and the web app that shows the
 * runs and the profile. A run is a `FormRun` (packages/core/src/opportunity.ts) with the opportunity it was queued for copied in, so
 * the discovery track only has to call `queueFormRun` with its record and the person's 报名; nothing here reads its tables.
 *
 * A sensitive profile value is never here: `apply.sensitive` keeps only that a slot is held in the worker's secret store and since when.
 */
const ownerOf = (store: CrosslineStore, workspaceId: string) => store.getWorkspaceOwnerId(workspaceId) ?? "system";
const RUNS_KEPT = 200;

export function readFormRuns(store: CrosslineStore, workspaceId: string): StoredFormRun[] {
  try { const parsed = JSON.parse(store.getSetting(workspaceId, FORM_RUNS_SETTING) ?? "[]") as StoredFormRun[]; return Array.isArray(parsed) ? parsed : []; }
  catch { return []; }
}
export const formRunOf = (store: CrosslineStore, workspaceId: string, id: string) => readFormRuns(store, workspaceId).find((run) => run.id === id);

/** Writes one run back (newest first, the oldest finished ones dropped past the cap) and records the change as an event. */
export function saveFormRun(store: CrosslineStore, workspaceId: string, run: StoredFormRun, event?: { type: string; payload?: Record<string, unknown> }): StoredFormRun {
  const next = { ...run, updatedAt: new Date().toISOString() };
  const others = readFormRuns(store, workspaceId).filter((item) => item.id !== run.id);
  store.setSetting(workspaceId, FORM_RUNS_SETTING, JSON.stringify([next, ...others].slice(0, RUNS_KEPT)));
  if (event) store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, type: event.type, entityId: run.id,
    idempotencyKey: `${event.type}:${run.id}:${Date.now()}:${randomUUID().slice(0, 8)}`,
    payload: { opportunityId: run.opportunityId, host: run.host, state: next.state, pageNo: next.pageNo, ...(next.stoppedFor ? { stoppedFor: next.stoppedFor } : {}), ...(event.payload ?? {}) } });
  return next;
}

/**
 * The discovery track's hand-over: the person pressed 报名 (or 申请, once the materials are ready) on the offer card. One open run per
 * opportunity — pressing again returns the one already there. The registration host is the opportunity's own; nothing else is opened.
 */
export function queueFormRun(store: CrosslineStore, workspaceId: string, input: { opportunity: Opportunity; choice: "register" | "apply"; at?: string;
  drafts?: StoredFormRun["drafts"] }): StoredFormRun {
  const open = readFormRuns(store, workspaceId).find((run) => run.opportunityId === input.opportunity.id && !["confirmed", "stopped"].includes(run.state));
  if (open) return open;
  const host = input.opportunity.registrationHost.toLowerCase().replace(/^www\./, "");
  if (!host || /[\s/]/.test(host)) throw new Error("FORM_HOST_INVALID");
  const at = input.at ?? new Date().toISOString();
  const run: StoredFormRun = { id: `form-${randomUUID().slice(0, 12)}`, opportunityId: input.opportunity.id, host, state: "queued", pageNo: 0,
    filled: [], screenshots: [], engines: [], opportunity: input.opportunity, decision: { choice: input.choice, at, by: "person" },
    queuedAt: at, updatedAt: at, pages: [], ...(input.drafts ? { drafts: input.drafts } : {}) };
  return saveFormRun(store, workspaceId, run, { type: "opportunity.form.queued", payload: { choice: input.choice } });
}

// ———————————————————————————————————————— the application profile

type SensitiveRecord = Partial<Record<ApplicationSlot, { confirmedAt: string }>>;
export function readSensitiveRecord(store: CrosslineStore, workspaceId: string): SensitiveRecord {
  try { return JSON.parse(store.getSetting(workspaceId, SENSITIVE_PROFILE_SETTING) ?? "{}") as SensitiveRecord; } catch { return {}; }
}
/** That a sensitive slot is held (or no longer is) in the secret store; the value itself is written there by the worker only. */
export function recordSensitiveSlot(store: CrosslineStore, workspaceId: string, slot: ApplicationSlot, held: boolean): void {
  const record = readSensitiveRecord(store, workspaceId);
  if (held) record[slot] = { confirmedAt: new Date().toISOString() }; else delete record[slot];
  store.setSetting(workspaceId, SENSITIVE_PROFILE_SETTING, JSON.stringify(record));
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, type: held ? "apply.profile.saved" : "apply.profile.removed", entityId: slot,
    idempotencyKey: `apply.profile:${slot}:${Date.now()}:${randomUUID().slice(0, 8)}`, payload: { slot, sensitive: true } });
}

export const applicationProfile = (store: CrosslineStore, workspaceId: string): ProfileItem[] =>
  assembleProfile(store.listProfileFacts(workspaceId, { identityId: "person" }).concat(store.listProfileFacts(workspaceId).filter((fact) => fact.identityId !== "person")),
    readSensitiveRecord(store, workspaceId));

/** A non-sensitive slot confirmed by the person: a confirmed `apply.<slot>` fact on the person line, reused by every later form. */
export function saveProfileFact(store: CrosslineStore, workspaceId: string, slot: ApplicationSlot, value: string, sourceRef: string): void {
  if (isSensitiveSlot(slot)) throw new Error("PROFILE_SLOT_SENSITIVE");
  store.upsertProfileFact({ workspaceId, identityId: "person", projectId: "", slot: applySlotFact(slot), value: value.trim().slice(0, 500), status: "confirmed",
    sourceRef, sourceQuote: "", updatedAt: new Date().toISOString() });
  store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, type: "apply.profile.saved", entityId: slot,
    idempotencyKey: `apply.profile:${slot}:${Date.now()}:${randomUUID().slice(0, 8)}`, payload: { slot, sensitive: false, sourceRef } });
}
export function removeProfileFact(store: CrosslineStore, workspaceId: string, slot: ApplicationSlot): boolean {
  const removed = store.deleteProfileFact(workspaceId, "person", "", applySlotFact(slot));
  if (removed) store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, type: "apply.profile.removed", entityId: slot,
    idempotencyKey: `apply.profile:${slot}:${Date.now()}:${randomUUID().slice(0, 8)}`, payload: { slot, sensitive: false } });
  return removed;
}

/** Which runs used each slot (§12: 「每项看用在了哪些报名里」), newest first. */
export function profileUsage(store: CrosslineStore, workspaceId: string): Partial<Record<ApplicationSlot, Array<{ runId: string; title: string; at: string; state: StoredFormRun["state"] }>>> {
  const usage: Partial<Record<ApplicationSlot, Array<{ runId: string; title: string; at: string; state: StoredFormRun["state"] }>>> = {};
  for (const run of readFormRuns(store, workspaceId)) {
    const slots = new Set(run.filled.map((item) => item.slot).filter((slot): slot is ApplicationSlot => Boolean(slot && slot in APPLICATION_SLOTS)));
    for (const slot of slots) (usage[slot] ??= []).push({ runId: run.id, title: run.opportunity.title, at: run.updatedAt, state: run.state });
  }
  return usage;
}
