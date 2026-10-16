import { ONBOARDING_STAGES } from "./onboarding-turn-schema";

/**
 * What an installed copy may tell the owner's collector about how it is used (docs/local-installer.md, 回传). Behaviour, never
 * content: no free text of any kind, no file names, no URLs, no entity id as it is — ids become a salted hash only this install can
 * produce, so two events about one task line up without saying which task.
 *
 * The whitelist is the shape below and nothing else. Every value is checked against what it may be — an event type from the list,
 * a stage from the enums, a code that looks like a code, a page that is one of the app's own route templates — and anything that
 * does not pass is dropped, not escaped. An event type that is not listed is never sent; adding one is a change to this file.
 * `apps/web/lib/telemetry-privacy.test.ts` proves the property by walking the source.
 *
 * Pure (no node modules): the collector (`collector/`) runs the same check on what it receives.
 */
/** "0" turns sending off (Settings → 隐私); anything else, including no row, is on. */
export const TELEMETRY_ENABLED_SETTING = "telemetry.enabled";

export const TELEMETRY_FIELDS = ["type", "at", "page", "stage", "skill", "ms", "repairs", "stalls", "ok", "code", "tokens", "counts", "entity", "version"] as const;
export const TELEMETRY_TOKEN_FIELDS = ["input", "cached", "output"] as const;
export const TELEMETRY_COUNT_FIELDS = ["captures", "tasks", "milestones", "timers", "confirmations", "rounds"] as const;

export type TelemetryEvent = {
  type: string;
  at: string;
  version: string;
  page?: string;
  stage?: string;
  skill?: string;
  ms?: number;
  repairs?: number;
  stalls?: number;
  ok?: boolean;
  code?: string;
  tokens?: Partial<Record<(typeof TELEMETRY_TOKEN_FIELDS)[number], number>>;
  counts?: Partial<Record<(typeof TELEMETRY_COUNT_FIELDS)[number], number>>;
  entity?: string;
};

/**
 * Every page the web app serves, as its route template. A page view is recorded only as one of these — never the path that was
 * opened, which carries ids — and `apps/web/lib/telemetry-privacy.test.ts` checks this list against the `page.tsx` files, so a new
 * page is added here or never reported.
 */
export const APP_PAGES = ["/", "/approvals", "/assistant", "/confirm/[id]", "/connect", "/login", "/materials/[id]", "/materials/view", "/milestones", "/milestones/[id]", "/offline",
  "/onboarding", "/plan", "/portrait", "/reset-password", "/return", "/review", "/set-password", "/settings", "/signup", "/workbench", "/workbench/[id]",
  "/workbench/[id]/material"] as const;

/** Ledger event types that are passed on (as themselves), and the ones made here from other tables. */
export const LEDGER_EVENT_TYPES = [
  "capture.created", "capture.discarded", "analysis.proposed", "analysis.accepted", "plan.approved", "approval.revoked",
  "work_order.transitioned", "work_order.archived", "work_order.deferred", "work_order.auto_approved", "human.started", "human.completed",
  "evidence.accepted", "milestone.proposed", "milestone.revised", "milestone_gate.judged", "milestone_gate.blocked",
  "milestone_gate.auto_accepted", "ask.answered", "ask.snoozed", "op.undone", "dates.decided", "portrait.written",
  "agent.task.requested", "agent.task.completed", "agent.task.blocked", "agent.delivered", "notification.sent",
  "goal.backplan_proposed", "goal.backplan_blocked", "task.progress_reported", "materials.ready", "manualbook.built"
] as const;
export const DERIVED_EVENT_TYPES = ["skill.run", "page.viewed", "onboarding.round", "counts.today", "install.started"] as const;
const EVENT_TYPES = new Set<string>([...LEDGER_EVENT_TYPES, ...DERIVED_EVENT_TYPES]);

const WORK_ORDER_STATES = ["captured", "analyzing", "awaiting_plan_approval", "approved", "preparing", "ready_for_human", "active",
  "evidence_review", "accepted", "blocked", "archived"];
const ASK_KINDS = ["backplan_input", "waiting_due", "capture_blocked", "materials_blocked", "gate_insufficient", "gate_failed", "evidence_manual",
  "milestone_risk", "agent_blocked", "calendar_publish_failed", "calendar_sync_failed", "codex_signed_out", "missed_block", "source_project",
  "calendar_line_unclear", "interview_open", "interview_question", "event_propose", "step_question", "relation_check", "background_paused",
  "locked_conflict"];
const GATE_VERDICTS = ["pass", "insufficient", "fail", "met", "partial", "unmet", "unverifiable"];
export const TELEMETRY_STAGES = new Set<string>([...ONBOARDING_STAGES, "complete", ...WORK_ORDER_STATES, ...ASK_KINDS, ...GATE_VERDICTS]);

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** A code is read only from fields the system writes (`error_code`, a payload's `code`); anything else shaped like one would pass too. */
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const SKILL = /^crossline-[a-z0-9-]{1,60}$/;
const VERSION = /^\d+\.\d+\.\d+(-[a-z0-9.]{1,20})?$/;
const ENTITY = /^[0-9a-f]{16}$/;
/** `/workbench/[id]`: lower-case path segments and bracketed parameters only. The route list itself is the app's (`pages`). */
const PAGE = /^\/([a-z0-9-]+|\[[a-zA-Z.]+\])(\/([a-z0-9-]+|\[[a-zA-Z.]+\]))*$|^\/$/;

const count = (value: unknown, max = 1e9): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? Math.round(value) : undefined;

/**
 * The last step before anything leaves: a new object holding only whitelisted keys whose values pass their check. Returns undefined
 * for an event that has no listed type, no valid time or no valid version — it is then not sent at all.
 */
export function sanitizeTelemetryEvent(input: unknown, pages: ReadonlySet<string>): TelemetryEvent | undefined {
  if (!input || typeof input !== "object") return undefined;
  const raw = input as Record<string, unknown>;
  if (typeof raw.type !== "string" || !EVENT_TYPES.has(raw.type)) return undefined;
  if (typeof raw.at !== "string" || !ISO.test(raw.at) || typeof raw.version !== "string" || !VERSION.test(raw.version)) return undefined;
  const out: TelemetryEvent = { type: raw.type, at: raw.at, version: raw.version };
  if (typeof raw.page === "string" && pages.has(raw.page) && PAGE.test(raw.page)) out.page = raw.page;
  if (typeof raw.stage === "string" && TELEMETRY_STAGES.has(raw.stage)) out.stage = raw.stage;
  if (typeof raw.skill === "string" && SKILL.test(raw.skill)) out.skill = raw.skill;
  if (typeof raw.code === "string" && CODE.test(raw.code)) out.code = raw.code;
  if (typeof raw.entity === "string" && ENTITY.test(raw.entity)) out.entity = raw.entity;
  if (typeof raw.ok === "boolean") out.ok = raw.ok;
  const ms = count(raw.ms, 7 * 24 * 3600 * 1000); if (ms !== undefined) out.ms = ms;
  const repairs = count(raw.repairs, 100); if (repairs !== undefined) out.repairs = repairs;
  const stalls = count(raw.stalls, 100); if (stalls !== undefined) out.stalls = stalls;
  for (const [key, fields] of [["tokens", TELEMETRY_TOKEN_FIELDS], ["counts", TELEMETRY_COUNT_FIELDS]] as const) {
    const source = raw[key];
    if (!source || typeof source !== "object") continue;
    const kept: Record<string, number> = {};
    for (const field of fields) { const value = count((source as Record<string, unknown>)[field]); if (value !== undefined) kept[field] = value; }
    if (Object.keys(kept).length) (out as Record<string, unknown>)[key] = kept;
  }
  return out;
}

/** The batch the collector receives. `account` is the SHA-256 of the Codex account's email, the one way the owner tells installs apart. */
export type TelemetryBatch = { install: string; account?: string; version: string; sentAt: string; events: TelemetryEvent[] };
const INSTALL = /^[0-9a-f-]{36}$/;
const SHA256 = /^[0-9a-f]{64}$/;
export const TELEMETRY_BATCH_LIMIT = 500;

export function sanitizeTelemetryBatch(input: { install: string; account?: string; version: string; sentAt: string; events: unknown[] },
  pages: ReadonlySet<string>): TelemetryBatch | undefined {
  if (!INSTALL.test(input.install) || !VERSION.test(input.version) || !ISO.test(input.sentAt)) return undefined;
  const events = input.events.map((event) => sanitizeTelemetryEvent(event, pages)).filter((event): event is TelemetryEvent => Boolean(event))
    .slice(0, TELEMETRY_BATCH_LIMIT);
  return { install: input.install, ...(input.account && SHA256.test(input.account) ? { account: input.account } : {}),
    version: input.version, sentAt: input.sentAt, events };
}

/** Turns one ledger event into its telemetry form, or undefined when its type is not passed on. Only coded fields are read. */
export function telemetryFromLedgerEvent(event: { type: string; entityId: string; payload: unknown; createdAt: string },
  context: { entity: (id: string) => string; version: string }): Record<string, unknown> | undefined {
  if (!(LEDGER_EVENT_TYPES as readonly string[]).includes(event.type)) return undefined;
  const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
  const stage = event.type === "work_order.transitioned" ? payload.to
    : event.type === "ask.answered" || event.type === "ask.snoozed" ? payload.kind
    : event.type === "milestone_gate.judged" ? payload.verdict ?? payload.result : undefined;
  return { type: event.type, at: event.createdAt, version: context.version, entity: context.entity(event.entityId),
    ...(typeof stage === "string" ? { stage } : {}), ...(typeof payload.code === "string" ? { code: payload.code } : {}) };
}

/** Maps a concrete path to the route template it was served by (`/workbench/abc` → `/workbench/[id]`), or undefined. */
export function pageTemplate(pathname: string, templates: readonly string[]): string | undefined {
  const parts = pathname.split("?")[0]!.split("/").filter(Boolean);
  let best: string | undefined;
  for (const template of templates) {
    const pattern = template.split("/").filter(Boolean);
    if (pattern.length !== parts.length) continue;
    if (!pattern.every((segment, index) => segment.startsWith("[") || segment === parts[index])) continue;
    // A literal segment beats a parameter: `/plan/settings` over `/plan/[id]`.
    if (!best || pattern.filter((segment) => !segment.startsWith("[")).length > best.split("/").filter((segment) => segment && !segment.startsWith("[")).length) best = template;
  }
  return best;
}
