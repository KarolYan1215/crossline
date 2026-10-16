import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { autoApprovalEligible, type AccessContext } from "@crossline/core";
import { ensureSeeded, getStore } from "./crossline";
import { localeFor, tOf } from "./locale";

const MODE_KEY = "permission.mode";
const WAIT_MS = 5 * 60_000;
const HEARTBEAT_MAX_MS = 15_000;
export type PermissionCandidate = { key: string; kind: "work_order" | "insight";
  id: string; title: string; eligible: boolean; reason: string; elapsedMs: number };
type Timer = { elapsedMs: number; lastSeenMs: number | null };
const timerKey = (key: string) => `permission.timer:${key}`;
const keyOf = (kind: string, id: string, version: unknown) =>
  createHash("sha256").update(JSON.stringify([kind, id, version])).digest("hex").slice(0, 32);

export function permissionModeEnabled(ctx: AccessContext): boolean {
  return getStore().getSetting(ctx.workspaceId, MODE_KEY) === "on";
}

export function setPermissionMode(ctx: AccessContext, enabled: boolean): { enabled: boolean } {
  ensureSeeded(ctx);
  const previous = permissionModeEnabled(ctx);
  if (previous === enabled) return { enabled };
  const store = getStore();
  if (!enabled) for (const candidate of permissionCandidates(ctx)) {
    const timer = readTimer(ctx, candidate.key);
    store.setSetting(ctx.workspaceId, timerKey(candidate.key), JSON.stringify({ ...timer, lastSeenMs: null }));
  }
  store.setSetting(ctx.workspaceId, MODE_KEY, enabled ? "on" : "off");
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `permission:mode:${randomUUID()}`, type: "permission.mode_changed",
    entityId: ctx.workspaceId, payload: { enabled } });
  return { enabled };
}

function readTimer(ctx: AccessContext, key: string): Timer {
  try {
    const value = JSON.parse(getStore().getSetting(ctx.workspaceId, timerKey(key)) ?? "null") as Timer | null;
    return value && Number.isFinite(value.elapsedMs) ? value : { elapsedMs: 0, lastSeenMs: null };
  } catch { return { elapsedMs: 0, lastSeenMs: null }; }
}

export function permissionCandidates(ctx: AccessContext): PermissionCandidate[] {
  ensureSeeded(ctx);
  const store = getStore();
  const t = tOf(ctx);
  const orders = store.listWorkOrders(ctx.workspaceId).filter((order) => order.state === "awaiting_plan_approval")
    .map((order) => {
      // The same rule the worker applies the moment a proposal is written (`autoApprovalEligible`): two
      // rules for "may this go ahead without a click" would disagree about the same card.
      const eligible = autoApprovalEligible(order, { locale: localeFor(ctx) }).eligible;
      const key = keyOf("work_order", order.id, order);
      return { key, kind: "work_order" as const, id: order.id, title: order.intent, eligible,
        reason: eligible ? t("普通本地作业，可在前台满 5 分钟后默认批准") : t("风险或外部动作需要明确批准"),
        elapsedMs: readTimer(ctx, key).elapsedMs };
    });
  const decided = new Set(store.listEvents(ctx.workspaceId, { type: ["insight.approved", "insight.rejected"] })
    .map((event) => event.entityId));
  const insights = store.listEvents(ctx.workspaceId, { type: "flywheel.finding" })
    .filter((event) => !decided.has(event.eventId)).map((event) => {
      const finding = event.payload as { summary?: string; sourceUrl?: string; staleWhen?: string; milestoneId?: string };
      const eligible = Boolean(finding.summary?.trim() && finding.sourceUrl?.startsWith("https://")
        && finding.staleWhen?.trim() && store.listMilestones(ctx.workspaceId)
          .some((milestone) => milestone.id === finding.milestoneId && milestone.status === "approved"));
      const key = keyOf("insight", event.eventId, event.payload);
      return { key, kind: "insight" as const, id: event.eventId, title: finding.summary ?? t("未命名洞察"),
        eligible, reason: eligible ? t("有来源、失效条件且可撤销的洞察补丁") : t("来源或目标不足，须明确核对"),
        elapsedMs: readTimer(ctx, key).elapsedMs };
    });
  return [...orders, ...insights];
}

export function approveInsight(ctx: AccessContext, eventId: string, key: string): boolean {
  const store = getStore();
  const finding = store.listEvents(ctx.workspaceId, { type: "flywheel.finding" }).find((event) => event.eventId === eventId);
  if (!finding || keyOf("insight", finding.eventId, finding.payload) !== key
    || !permissionCandidates(ctx).some((candidate) => candidate.key === key && candidate.eligible)
    || store.listEvents(ctx.workspaceId, { type: ["insight.approved", "insight.rejected"] })
      .some((event) => event.entityId === eventId)) return false;
  return store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `insight:approved:${key}`, type: "insight.approved",
    entityId: eventId, payload: { milestoneId: finding.entityId, findingEventId: eventId } }).inserted;
}

export function revokeInsight(ctx: AccessContext, eventId: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  if (!store.listEvents(ctx.workspaceId, { type: "insight.approved", entityId: eventId }).length
    || store.listEvents(ctx.workspaceId, { type: "insight.revoked", entityId: eventId }).length)
    return { ok: false, code: "INSIGHT_NOT_ACTIVE" };
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `insight:revoked:${eventId}`, type: "insight.revoked", entityId: eventId,
    payload: { reason: "user_revoked" } });
  return { ok: true };
}

export function accrueVisibleTime(timer: Timer, nowMs: number, visible: boolean): Timer {
  if (!visible) return { elapsedMs: timer.elapsedMs, lastSeenMs: null };
  const gap = timer.lastSeenMs === null ? 0 : nowMs - timer.lastSeenMs;
  return { elapsedMs: timer.elapsedMs + (gap >= 0 && gap <= HEARTBEAT_MAX_MS ? gap : 0), lastSeenMs: nowMs };
}

function applyCandidate(ctx: AccessContext, candidate: PermissionCandidate, status: "approved" | "excluded"): boolean {
  const store = getStore();
  if (candidate.kind === "insight") return status === "approved" && approveInsight(ctx, candidate.id, candidate.key);
  const order = store.listWorkOrders(ctx.workspaceId).find((item) => item.id === candidate.id);
  if (!order || order.state !== "awaiting_plan_approval"
    || keyOf("work_order", order.id, order) !== candidate.key) return false;
  try {
    return store.transitionWorkOrder(ctx.workspaceId, order.id,
      status === "approved" ? { type: "plan.approved", approvalId: ctx.principalId }
        : { type: "blocked", reason: "USER_REJECTED_PROPOSAL" },
      `permission:proposal:${status}:${candidate.key}`, { expectedWorkOrder: order }).changed;
  } catch (error) {
    if (error instanceof Error && error.message === "PROPOSAL_VERSION_CHANGED") return false;
    throw error;
  }
}

export function permissionHeartbeat(ctx: AccessContext, keys: string[], visible: boolean, nowMs = Date.now()): {
  candidates: PermissionCandidate[]; applied: string[]
} {
  if (!permissionModeEnabled(ctx)) return { candidates: permissionCandidates(ctx), applied: [] };
  const store = getStore();
  const candidates = permissionCandidates(ctx);
  const active = new Set(keys.filter((key) => typeof key === "string" && /^[a-f0-9]{32}$/.test(key)));
  const applied: string[] = [];
  for (const candidate of candidates.filter((item) => item.eligible && active.has(item.key))) {
    const timer = accrueVisibleTime(readTimer(ctx, candidate.key), nowMs, visible);
    store.setSetting(ctx.workspaceId, timerKey(candidate.key), JSON.stringify(timer));
    if (timer.elapsedMs < WAIT_MS || !visible) continue;
    const changed = applyCandidate(ctx, candidate, "approved");
    if (!changed) continue;
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
      idempotencyKey: `permission:auto:${candidate.key}`, type: "permission.auto_approved",
      entityId: candidate.id, payload: { kind: candidate.kind, versionKey: candidate.key, visibleMs: timer.elapsedMs } });
    applied.push(candidate.key);
  }
  return { candidates: permissionCandidates(ctx), applied };
}

export function rejectPermissionCandidate(ctx: AccessContext, key: string): { ok: true } | { ok: false; code: string } {
  const candidate = permissionCandidates(ctx).find((item) => item.key === key);
  if (!candidate) return { ok: false, code: "PERMISSION_CANDIDATE_STALE" };
  const store = getStore();
  if (candidate.kind !== "insight") {
    if (!applyCandidate(ctx, candidate, "excluded")) return { ok: false, code: "PERMISSION_CANDIDATE_STALE" };
  } else {
    store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
      idempotencyKey: `insight:rejected:${key}`, type: "insight.rejected", entityId: candidate.id,
      payload: { reason: "user_rejected" } });
  }
  store.appendEvent({ ownerId: ctx.principalId, workspaceId: ctx.workspaceId,
    idempotencyKey: `permission:reject-audit:${key}`, type: "permission.rejected",
    entityId: candidate.id, payload: { kind: candidate.kind, versionKey: key } });
  return { ok: true };
}

export function approvePermissionCandidate(ctx: AccessContext, key: string): { ok: true } | { ok: false; code: string } {
  const candidate = permissionCandidates(ctx).find((item) => item.key === key && item.kind === "insight" && item.eligible);
  if (!candidate || !approveInsight(ctx, candidate.id, key)) return { ok: false, code: "PERMISSION_CANDIDATE_STALE" };
  return { ok: true };
}
