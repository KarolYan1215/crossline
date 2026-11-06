import "server-only";
import type { AccessContext, Ask } from "@crossline/core";
import { getStore } from "./crossline";

/**
 * Folding many asks of one kind into one card (W-228, 2026-11-05): two or more decisions that only the person can make (an overdue date,
 * a proposed watch) come as one card listing them, never one card each — the same rule the missed blocks and the weekly risk card follow.
 * 「逐个处理」 splits the card: the members it listed are their own cards from then on, while new ones fold again. A folded card's id
 * starts `fold:<key>:`, and its fingerprint is its members' ask ids, which is what a split records.
 */
export const FOLD_SPLIT_SETTING = "asks.fold.split";
const SPLIT_KEPT = 300;

function readSplit(ctx: AccessContext): Record<string, string[]> {
  try {
    const parsed = JSON.parse(getStore().getSetting(ctx.workspaceId, FOLD_SPLIT_SETTING) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string[]> : {};
  } catch { return {}; }
}

export const foldId = (key: string, members: Ask[]) => `fold:${key}:${members.length}:${members.map((ask) => ask.id).sort()[0] ?? ""}`;
export const foldFingerprint = (members: Ask[]) => members.map((ask) => ask.id).sort().join("|");

/** The members split off earlier stay their own cards; two or more of the rest are `build`'s one card, one alone is itself. */
export function foldAsks(ctx: AccessContext, key: string, members: Ask[], build: (members: Ask[]) => Ask): Ask[] {
  const split = new Set(readSplit(ctx)[key] ?? []);
  const apart = members.filter((ask) => split.has(ask.id));
  const rest = members.filter((ask) => !split.has(ask.id));
  return rest.length >= 2 ? [...apart, build(rest)] : members;
}

export const isFolded = (ask: Ask) => ask.id.startsWith("fold:");

/** 「逐个处理」 on a folded card: its members become their own cards. */
export function splitFold(ctx: AccessContext, ask: Ask): { ok: true } {
  const key = ask.id.split(":")[1] ?? "";
  const all = readSplit(ctx);
  all[key] = [...new Set([...(all[key] ?? []), ...ask.fingerprint.split("|").filter(Boolean)])].slice(-SPLIT_KEPT);
  getStore().setSetting(ctx.workspaceId, FOLD_SPLIT_SETTING, JSON.stringify(all));
  return { ok: true };
}
