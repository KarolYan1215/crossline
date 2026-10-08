import "server-only";
import type { AccessContext } from "@crossline/core";
import { LINE_PALETTE, LINE_SETTING, defaultIdentityPacks, freeLineColor, identityPacksFor, newLineId, readLineSpecs, type IdentityPack, type LineSpec } from "@crossline/identity-packs";
import { getStore } from "./crossline";

/** Every pack this workspace works with: its lines (built-in or its own) and the capacity pack. */
export function linePacks(ctx: AccessContext, options: { includeArchived?: boolean } = {}): IdentityPack[] {
  return identityPacksFor((key) => getStore().getSetting(ctx.workspaceId, key), options);
}
/** The lines alone (no capacity pack). */
export const identityLines = (ctx: AccessContext) => linePacks(ctx).filter((pack) => pack.kind === "identity");
/** Line id → name, archived lines included so old work still reads with its line's name. */
export const lineLabels = (ctx: AccessContext): Record<string, string> =>
  Object.fromEntries(linePacks(ctx, { includeArchived: true }).map((pack) => [pack.id, pack.label]));

/** The stored list, or the built-in four written out as the person's own (the first time an account edits its lines). */
function currentSpecs(ctx: AccessContext): LineSpec[] {
  const stored = readLineSpecs((key) => getStore().getSetting(ctx.workspaceId, key));
  if (stored) return stored;
  return defaultIdentityPacks().filter((pack) => pack.kind === "identity").map((pack) => ({ id: pack.id, label: pack.label, color: pack.id, goal: "", createdAt: "" }));
}
function saveSpecs(ctx: AccessContext, specs: LineSpec[], event: { type: string; entityId: string; payload: Record<string, unknown> }): void {
  const store = getStore();
  store.setSetting(ctx.workspaceId, LINE_SETTING, JSON.stringify(specs));
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId, idempotencyKey: `${event.type}:${event.entityId}:${Date.now()}`, ...event });
}

/** A new line: its name, its long-term goal and a free colour. Its interview (`/onboarding?line=<id>`) comes next. */
export function addLine(ctx: AccessContext, input: { label: string; goal: string; color?: string }): { ok: true; id: string } | { ok: false; code: string } {
  const label = input.label.trim().slice(0, 20);
  if (!label) return { ok: false, code: "LINE_LABEL_REQUIRED" };
  const specs = currentSpecs(ctx);
  if (specs.some((line) => !line.archived && line.label === label)) return { ok: false, code: "LINE_LABEL_TAKEN" };
  const id = newLineId(label, specs.map((line) => line.id));
  const color = input.color && LINE_PALETTE[input.color] ? input.color : freeLineColor(specs);
  saveSpecs(ctx, [...specs, { id, label, color, goal: input.goal.trim().slice(0, 300), createdAt: new Date().toISOString() }],
    { type: "line.created", entityId: id, payload: { label, color } });
  return { ok: true, id };
}

/** Renames a line, sets its goal or colour, or archives it (its work stays, filed under it). */
export function updateLine(ctx: AccessContext, id: string, change: { label?: string; goal?: string; color?: string; archived?: boolean }): { ok: true } | { ok: false; code: string } {
  const specs = currentSpecs(ctx);
  const line = specs.find((item) => item.id === id);
  if (!line) return { ok: false, code: "LINE_NOT_FOUND" };
  const next: LineSpec = { ...line,
    ...(change.label !== undefined && change.label.trim() ? { label: change.label.trim().slice(0, 20) } : {}),
    ...(change.goal !== undefined ? { goal: change.goal.trim().slice(0, 300) } : {}),
    ...(change.color && LINE_PALETTE[change.color] ? { color: change.color } : {}),
    ...(change.archived !== undefined ? { archived: change.archived } : {}) };
  saveSpecs(ctx, specs.map((item) => item.id === id ? next : item), { type: "line.updated", entityId: id, payload: change });
  return { ok: true };
}
