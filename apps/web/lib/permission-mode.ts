import "server-only";
import { createHash, randomUUID } from "node:crypto";
import { ensureSeeded, getStore, WORKSPACE_ID } from "./crossline";

const OWNER_ID = "local-owner";
const MODE_KEY = "permission.mode";
const WAIT_MS = 5 * 60_000;
const HEARTBEAT_MAX_MS = 15_000;
export type PermissionCandidate = { key: string; kind: "work_order" | "plan_change" | "insight";
  id: string; title: string; eligible: boolean; reason: string; elapsedMs: number };
type Timer = { elapsedMs: number; lastSeenMs: number | null };
const timerKey = (key: string) => `permission.timer:${key}`;
const keyOf = (kind: string, id: string, version: unknown) =>
  createHash("sha256").update(JSON.stringify([kind, id, version])).digest("hex").slice(0, 32);
const explicitRisk = /\b(email|message|publish|post|submit|purchase|sell|buy|sign|legal|transfer|delete|trade|order|file)\b|邮件|发送|发布|投稿|提交|购买|出售|签署|法律|转账|删除|交易|订单|券商|产权|财产/i;

export function permissionModeEnabled(): boolean {
  return getStore().getSetting(WORKSPACE_ID, MODE_KEY) === "on";
}

export function setPermissionMode(enabled: boolean): { enabled: boolean } {
  ensureSeeded();
  const previous = permissionModeEnabled();
  if (previous === enabled) return { enabled };
  const store = getStore();
  if (!enabled) for (const candidate of permissionCandidates()) {
    const timer = readTimer(candidate.key);
    store.setSetting(WORKSPACE_ID, timerKey(candidate.key), JSON.stringify({ ...timer, lastSeenMs: null }));
  }
  store.setSetting(WORKSPACE_ID, MODE_KEY, enabled ? "on" : "off");
  store.appendEvent({ ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
    idempotencyKey: `permission:mode:${randomUUID()}`, type: "permission.mode_changed",
    entityId: WORKSPACE_ID, payload: { enabled } });
  return { enabled };
}

function readTimer(key: string): Timer {
  try {
    const value = JSON.parse(getStore().getSetting(WORKSPACE_ID, timerKey(key)) ?? "null") as Timer | null;
    return value && Number.isFinite(value.elapsedMs) ? value : { elapsedMs: 0, lastSeenMs: null };
  } catch { return { elapsedMs: 0, lastSeenMs: null }; }
}

export function permissionCandidates(): PermissionCandidate[] {
  ensureSeeded();
  const store = getStore();
  const orders = store.listWorkOrders(WORKSPACE_ID).filter((order) => order.state === "awaiting_plan_approval")
    .map((order) => {
      const content = `${order.intent} ${JSON.stringify(order.payload)}`;
      const eligible = order.riskTier === "routine" && !explicitRisk.test(content);
      const key = keyOf("work_order", order.id, order);
      return { key, kind: "work_order" as const, id: order.id, title: order.intent, eligible,
        reason: eligible ? "普通本地作业，可在前台满 5 分钟后默认批准" : "风险或外部动作需要明确批准",
        elapsedMs: readTimer(key).elapsedMs };
    });
  const plan = store.listPlanVersions(WORKSPACE_ID)[0];
  const changes = plan?.status === "draft" ? store.listPlanChanges(plan.id)
    .filter((change) => change.status === "pending").map((change) => {
      const eligible = change.kind !== "conflict";
      const key = keyOf("plan_change", change.id, [plan, change]);
      return { key, kind: "plan_change" as const, id: change.id, title: change.explanation, eligible,
        reason: eligible ? "非冲突计划变化，可在前台满 5 分钟后默认采纳" : "现实冲突必须明确处理",
        elapsedMs: readTimer(key).elapsedMs };
    }) : [];
  const decided = new Set(store.listEvents(WORKSPACE_ID, { type: ["insight.approved", "insight.rejected"] })
    .map((event) => event.entityId));
  const insights = store.listEvents(WORKSPACE_ID, { type: "flywheel.finding" })
    .filter((event) => !decided.has(event.eventId)).map((event) => {
      const finding = event.payload as { summary?: string; sourceUrl?: string; staleWhen?: string; milestoneId?: string };
      const eligible = Boolean(finding.summary?.trim() && finding.sourceUrl?.startsWith("https://")
        && finding.staleWhen?.trim() && store.listMilestones(WORKSPACE_ID)
          .some((milestone) => milestone.id === finding.milestoneId && milestone.status === "approved"));
      const key = keyOf("insight", event.eventId, event.payload);
      return { key, kind: "insight" as const, id: event.eventId, title: finding.summary ?? "未命名洞察",
        eligible, reason: eligible ? "有来源、失效条件且可撤销的洞察补丁" : "来源或目标不足，须明确核对",
        elapsedMs: readTimer(key).elapsedMs };
    });
  return [...orders, ...changes, ...insights];
}

export function approveInsight(eventId: string, key: string): boolean {
  const store = getStore();
  const finding = store.listEvents(WORKSPACE_ID, { type: "flywheel.finding" }).find((event) => event.eventId === eventId);
  if (!finding || keyOf("insight", finding.eventId, finding.payload) !== key
    || !permissionCandidates().some((candidate) => candidate.key === key && candidate.eligible)
    || store.listEvents(WORKSPACE_ID, { type: ["insight.approved", "insight.rejected"] })
      .some((event) => event.entityId === eventId)) return false;
  return store.appendEvent({ ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
    idempotencyKey: `insight:approved:${key}`, type: "insight.approved",
    entityId: eventId, payload: { milestoneId: finding.entityId, findingEventId: eventId } }).inserted;
}

export function revokeInsight(eventId: string): { ok: true } | { ok: false; code: string } {
  const store = getStore();
  if (!store.listEvents(WORKSPACE_ID, { type: "insight.approved", entityId: eventId }).length
    || store.listEvents(WORKSPACE_ID, { type: "insight.revoked", entityId: eventId }).length)
    return { ok: false, code: "INSIGHT_NOT_ACTIVE" };
  store.appendEvent({ ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
    idempotencyKey: `insight:revoked:${eventId}`, type: "insight.revoked", entityId: eventId,
    payload: { reason: "user_revoked" } });
  return { ok: true };
}

export function accrueVisibleTime(timer: Timer, nowMs: number, visible: boolean): Timer {
  if (!visible) return { elapsedMs: timer.elapsedMs, lastSeenMs: null };
  const gap = timer.lastSeenMs === null ? 0 : nowMs - timer.lastSeenMs;
  return { elapsedMs: timer.elapsedMs + (gap >= 0 && gap <= HEARTBEAT_MAX_MS ? gap : 0), lastSeenMs: nowMs };
}

function applyCandidate(candidate: PermissionCandidate, status: "approved" | "excluded"): boolean {
  const store = getStore();
  if (candidate.kind === "insight") return status === "approved" && approveInsight(candidate.id, candidate.key);
  if (candidate.kind === "work_order") {
    const order = store.listWorkOrders(WORKSPACE_ID).find((item) => item.id === candidate.id);
    if (!order || order.state !== "awaiting_plan_approval"
      || keyOf("work_order", order.id, order) !== candidate.key) return false;
    try {
      return store.transitionWorkOrder(WORKSPACE_ID, order.id,
        status === "approved" ? { type: "plan.approved", approvalId: OWNER_ID }
          : { type: "blocked", reason: "USER_REJECTED_PROPOSAL" },
        `permission:proposal:${status}:${candidate.key}`, { expectedWorkOrder: order }).changed;
    } catch (error) {
      if (error instanceof Error && error.message === "PROPOSAL_VERSION_CHANGED") return false;
      throw error;
    }
  }
  const plan = store.listPlanVersions(WORKSPACE_ID)[0];
  const change = plan && store.listPlanChanges(plan.id).find((item) => item.id === candidate.id);
  if (!plan || plan.status !== "draft" || !change || change.status !== "pending"
    || keyOf("plan_change", change.id, [plan, change]) !== candidate.key) return false;
  try {
    return store.resolvePlanChange(WORKSPACE_ID, change.id, status,
      `permission:plan-change:${status}:${candidate.key}`, { plan, change }).changed;
  } catch (error) {
    if (error instanceof Error && error.message === "PROPOSAL_VERSION_CHANGED") return false;
    throw error;
  }
}

export function permissionHeartbeat(keys: string[], visible: boolean, nowMs = Date.now()): {
  candidates: PermissionCandidate[]; applied: string[]
} {
  if (!permissionModeEnabled()) return { candidates: permissionCandidates(), applied: [] };
  const store = getStore();
  const candidates = permissionCandidates();
  const active = new Set(keys.filter((key) => typeof key === "string" && /^[a-f0-9]{32}$/.test(key)));
  const applied: string[] = [];
  for (const candidate of candidates.filter((item) => item.eligible && active.has(item.key))) {
    const timer = accrueVisibleTime(readTimer(candidate.key), nowMs, visible);
    store.setSetting(WORKSPACE_ID, timerKey(candidate.key), JSON.stringify(timer));
    if (timer.elapsedMs < WAIT_MS || !visible) continue;
    const changed = applyCandidate(candidate, "approved");
    if (!changed) continue;
    store.appendEvent({ ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
      idempotencyKey: `permission:auto:${candidate.key}`, type: "permission.auto_approved",
      entityId: candidate.id, payload: { kind: candidate.kind, versionKey: candidate.key, visibleMs: timer.elapsedMs } });
    applied.push(candidate.key);
  }
  return { candidates: permissionCandidates(), applied };
}

export function rejectPermissionCandidate(key: string): { ok: true } | { ok: false; code: string } {
  const candidate = permissionCandidates().find((item) => item.key === key);
  if (!candidate) return { ok: false, code: "PERMISSION_CANDIDATE_STALE" };
  const store = getStore();
  if (candidate.kind !== "insight") {
    if (!applyCandidate(candidate, "excluded")) return { ok: false, code: "PERMISSION_CANDIDATE_STALE" };
  } else {
    store.appendEvent({ ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
      idempotencyKey: `insight:rejected:${key}`, type: "insight.rejected", entityId: candidate.id,
      payload: { reason: "user_rejected" } });
  }
  store.appendEvent({ ownerId: OWNER_ID, workspaceId: WORKSPACE_ID,
    idempotencyKey: `permission:reject-audit:${key}`, type: "permission.rejected",
    entityId: candidate.id, payload: { kind: candidate.kind, versionKey: key } });
  return { ok: true };
}

export function approvePermissionCandidate(key: string): { ok: true } | { ok: false; code: string } {
  const candidate = permissionCandidates().find((item) => item.key === key && item.kind === "insight" && item.eligible);
  if (!candidate || !approveInsight(candidate.id, key)) return { ok: false, code: "PERMISSION_CANDIDATE_STALE" };
  return { ok: true };
}
