import { needFromProposal, type EligibilityTerm, type StoredNeed } from "./opportunity-discovery";
import { ELIGIBILITY_DIMS, type NeedSource, type Opportunity } from "./opportunity";
import {
  EXPLORE_SHARE, LOCAL_MINUTES_MAX, OUTCOME_WEIGHT, RETIRE_AFTER_RUNS, RETIRE_QUIET_DAYS, WATCH_TOOLS,
  type Feasibility, type LessFeedback, type OpportunityOutcome, type Watch, type WatchStats, type WatchTarget, type WatchTool
} from "./opportunity-watch";

/**
 * Track ① of the opportunity agent's second version (docs/opportunity-agent.md §17.2–17.4): watches as the ledger keeps them, the
 * needs Skill's watch proposals and their checks, the one-to-one migration of the old needs, and the flywheel's bookkeeping — outcomes,
 * yield, retiring, 「少来」 and the exploration share — all computed here by code, never by a model. Pure: the ledger side is in
 * `packages/db/src/opportunity-watches.ts`, the runs in `apps/worker/src/opportunities.ts` and `opportunity-scout.ts`.
 */

/** Every watch of a workspace (`StoredWatch[]`), in the ledger so a backup carries it. Replaces `scout.needs`, which is left as it was. */
export const WATCHES_SETTING = "opportunity.watches";
/** Per watch, what each target looked like last run (`{ [watchId]: { [targetKey]: { hash?, ids? } } }`): the change detection's memory. */
export const WATCH_SEEN_SETTING = "opportunity.watchSeen";
/** What 「少来」 adjusted outside one watch (`WatchTuning`): times that do not fit, sources already known, sources trusted less. */
export const WATCH_TUNING_SETTING = "opportunity.tuning";
/** Every 「少来」 with what it changed and how to take it back (`LessEntry[]`). */
export const LESS_LOG_SETTING = "opportunity.less";
/** The weekly scout's own bookkeeping (`ScoutStats`). */
export const SCOUT_STATS_SETTING = "opportunity.scout";
/** An opportunity the scout found carries this as its `needId` prefix (`scout:<YYYY-MM-DD>`), the watch id of everything else. */
export const SCOUT_NEED_PREFIX = "scout:";

export type StoredWatch = Watch & {
  createdAt: string;
  updatedAt: string;
  decidedAt?: string | undefined;
  /** Who retired it: the person (不要, 关掉) or the yield rule (shown restorable in the settings table). */
  retiredBy?: "person" | "system" | undefined;
  /** How long before a deadline preparation has to start; the latest start on the card and 「以后再说」 are worked back from it. */
  leadDays: number;
  /** Conditions found are screened against before reading (the derivation's assumptions plus what 「资格不符」 added), in words. */
  prescreen: string[];
  /** 「偏题」 halves it; under `WEIGHT_FLOOR` nothing the watch finds is surfaced. 1 by default. */
  weight: number;
  /** Raised by 「少来」 for the kind and by 「档次不够」: from 1 an opportunity whose eligibility is still a question is not surfaced. */
  strictness: number;
  /** A local event's limit one way, tightened by 「太远」; `LOCAL_MINUTES_MAX` until then. */
  radiusMinutes?: number | undefined;
  /** For a cycle: the day preparation has to start, said in the morning brief that day. */
  prepStartsOn?: string | undefined;
};

export type WatchTuning = {
  badTimes: Array<{ id: string; weekday: number; part: DayPart }>;
  knownHosts: string[];
  sourceWeights: Record<string, number>;
};
export type DayPart = "morning" | "afternoon" | "evening" | "any";

/** One 「少来」 and what it changed; `undo` lists exactly what to put back, so taking one back never undoes a later one. */
export type LessEntry = LessFeedback & {
  id: string;
  at: string;
  lineId: string;
  title: string;
  /** What changed, in the person's words for the weekly review and the settings table (interface text, already translated). */
  changes: string[];
  undo: {
    watch?: Partial<Pick<StoredWatch, "everyDays" | "strictness" | "weight" | "radiusMinutes" | "prescreen">> | undefined;
    badTimeId?: string | undefined;
    knownHost?: string | undefined;
    sourceWeight?: { host: string; before: number | null } | undefined;
    preferenceRef?: string | undefined;
  };
  undoneAt?: string | undefined;
};

export type ScoutStats = { runs: number; cost: number; lastRunAt?: string | undefined; outcomes: Partial<Record<OpportunityOutcome, number>> };

export const WEIGHT_FLOOR = 0.3;
export const SOURCE_WEIGHT_FLOOR = 0.3;
/** An opportunity surfaced and never answered counts as ignored after this many days (or once its deadline passed). */
export const IGNORED_AFTER_DAYS = 21;
/** A scout find is put to the person before the weekly review when its latest start is this close (§17.3: 「需要尽快准备」). */
export const SCOUT_URGENT_DAYS = 14;
const DAY = 86_400_000;

export const emptyStats = (): WatchStats => ({ runs: 0, found: 0, surfaced: 0, outcomes: {}, cost: 0 });
export const emptyTuning = (): WatchTuning => ({ badTimes: [], knownHosts: [], sourceWeights: {} });

const parse = <T>(raw: string | null | undefined, fallback: T): T => {
  try { const value = raw ? JSON.parse(raw) as T : fallback; return value ?? fallback; } catch { return fallback; }
};
export const readWatches = (raw: string | null | undefined): StoredWatch[] => { const list = parse<StoredWatch[]>(raw, []); return Array.isArray(list) ? list : []; };
export const readTuning = (raw: string | null | undefined): WatchTuning => ({ ...emptyTuning(), ...parse<Partial<WatchTuning>>(raw, {}) });
export const readLessLog = (raw: string | null | undefined): LessEntry[] => { const list = parse<LessEntry[]>(raw, []); return Array.isArray(list) ? list : []; };
export const readScoutStats = (raw: string | null | undefined): ScoutStats => ({ runs: 0, cost: 0, outcomes: {}, ...parse<Partial<ScoutStats>>(raw, {}) });

/** `YYYY-MM-DD` in the person's zone (§17.5: track A took the UTC day, which is tomorrow for a Chicago evening). */
export function dayInZone(at: Date, timeZone: string): string {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(at).map((part) => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
  } catch { return at.toISOString().slice(0, 10); }
}

// ── Migration (§17.2) ────────────────────────────────────────────────────────────────────────────────────────────────

const TOOL_OF_SOURCE: Record<NeedSource["kind"], WatchTool> = { ats: "ats_board", deadline_list: "deadline_list", events: "events_site", mail: "mail_search",
  web: "web_search", site_read: "site_read" };
export function targetOfSource(source: NeedSource): WatchTarget {
  switch (source.kind) {
    case "ats": return { tool: "ats_board", provider: source.provider, board: source.board, query: source.query ?? "" };
    case "deadline_list": return { tool: "deadline_list", list: source.list, query: source.query };
    case "events": return source.site === "devpost" ? { tool: "devpost", query: source.query } : { tool: "events_site", site: source.site, query: source.query };
    case "mail": return { tool: "mail_search", from: source.from ?? "", query: source.query };
    case "web": return { tool: "web_search", query: source.query };
    case "site_read": return { tool: "site_read", host: source.host, path: source.path };
  }
}
/** A target in words, for a watch's `query` and the settings table (model-facing; not interface text). */
/* i18n-ignore-start */
export function describeTarget(target: WatchTarget): string {
  switch (target.tool) {
    case "ats_board": return `${target.provider} 岗位接口 ${target.board}${target.query ? `（${target.query}）` : ""}`;
    case "deadline_list": return `会议截止库 ${target.list}：${target.query}`;
    case "devpost": return `Devpost：${target.query}`;
    case "events_site": return `${target.site}：${target.query}`;
    case "web_fetch": return target.url;
    case "mail_search": return `邮件${target.from ? ` ${target.from}` : ""}：${target.query}`;
    case "web_search": return `网页检索：${target.query}`;
    case "site_read": return `${target.host}${target.path}`;
  }
}
/* i18n-ignore-end */

/**
 * An `OpportunityNeed` as a watch, one to one (§17.2): the id stays, so opportunities found under it (`needId`) and its waiting item keep
 * their link; tracking becomes active, declined retired, proposed stays proposed; the sources become the query and the tools.
 */
export function watchFromNeed(need: StoredNeed, now: string, lastRunAt?: string): StoredWatch {
  const targets = need.sources.map(targetOfSource);
  const tools = [...new Set(need.sources.map((source) => source.kind === "events" && source.site === "devpost" ? "devpost" as const : TOOL_OF_SOURCE[source.kind]))];
  return {
    id: need.id, lineId: need.lineId, title: need.title, why: need.why, origin: "migrated",
    basis: { factIds: need.factIds, milestoneIds: need.milestoneIds, opportunityIds: [] },
    query: targets.map(describeTarget).join("；") || need.title, // i18n-ignore: model-facing
    tools, targets, judge: need.why, explore: false, everyDays: 1, horizonDays: need.kind === "cycle" ? 365 : 120,
    ...(need.kind === "cycle" && need.window ? { cycle: { opens: need.window.opens, closes: need.window.closes, sourceUrl: need.window.sourceUrl ?? "",
      confirmedAt: need.derivedAt ?? now } } : {}),
    state: need.state === "tracking" ? "active" : need.state === "declined" ? "retired" : "proposed",
    stats: { ...emptyStats(), ...(lastRunAt ? { lastRunAt } : {}) },
    createdAt: need.derivedAt ?? now, updatedAt: now, ...(need.decidedAt ? { decidedAt: need.decidedAt } : {}),
    leadDays: need.leadDays, prescreen: need.eligibility.map((rule) => rule.rule), weight: 1, strictness: 0,
    ...(need.prepStartsOn ? { prepStartsOn: need.prepStartsOn } : {})
  };
}

// ── The needs Skill proposes watches (§17.2) ─────────────────────────────────────────────────────────────────────────────

const TARGET_VARIANTS = [
  { type: "object", additionalProperties: false, required: ["tool", "provider", "board", "query"], properties: {
    tool: { type: "string", enum: ["ats_board"] }, provider: { type: "string", enum: ["greenhouse", "lever", "ashby"] },
    board: { type: "string", minLength: 1, maxLength: 60 }, query: { type: "string", maxLength: 60 } } },
  { type: "object", additionalProperties: false, required: ["tool", "list", "query"], properties: {
    tool: { type: "string", enum: ["deadline_list"] }, list: { type: "string", enum: ["ccfddl", "ai-deadlines"] }, query: { type: "string", minLength: 1, maxLength: 60 } } },
  { type: "object", additionalProperties: false, required: ["tool", "query"], properties: {
    tool: { type: "string", enum: ["devpost"] }, query: { type: "string", minLength: 1, maxLength: 80 } } },
  { type: "object", additionalProperties: false, required: ["tool", "site", "query"], properties: {
    tool: { type: "string", enum: ["events_site"] }, site: { type: "string", minLength: 2, maxLength: 60 }, query: { type: "string", minLength: 1, maxLength: 80 } } },
  { type: "object", additionalProperties: false, required: ["tool", "url"], properties: {
    tool: { type: "string", enum: ["web_fetch"] }, url: { type: "string", minLength: 9, maxLength: 400 } } },
  { type: "object", additionalProperties: false, required: ["tool", "from", "query"], properties: {
    tool: { type: "string", enum: ["mail_search"] }, from: { type: "string", maxLength: 80 }, query: { type: "string", minLength: 1, maxLength: 80 } } },
  { type: "object", additionalProperties: false, required: ["tool", "query"], properties: {
    tool: { type: "string", enum: ["web_search"] }, query: { type: "string", minLength: 1, maxLength: 160 } } }
] as const;

export const OPPORTUNITY_WATCHES_SCHEMA = {
  type: "object", additionalProperties: false, required: ["watches", "blocked"], properties: {
    watches: { type: "array", maxItems: 10, items: { type: "object", additionalProperties: false,
      required: ["key", "title", "why", "factIds", "milestoneIds", "query", "judge", "tools", "targets", "everyDays", "horizonDays", "leadDays", "cycle", "prescreen"],
      properties: {
        key: { type: "string", minLength: 2, maxLength: 60 },
        title: { type: "string", minLength: 2, maxLength: 80 },
        why: { type: "string", minLength: 4, maxLength: 300 },
        factIds: { type: "array", maxItems: 8, items: { type: "string", maxLength: 160 } },
        milestoneIds: { type: "array", maxItems: 6, items: { type: "string", maxLength: 120 } },
        query: { type: "string", minLength: 4, maxLength: 600 },
        judge: { type: "string", minLength: 4, maxLength: 400 },
        tools: { type: "array", minItems: 1, maxItems: WATCH_TOOLS.length, items: { type: "string", enum: [...WATCH_TOOLS] } },
        targets: { type: "array", maxItems: 12, items: { anyOf: TARGET_VARIANTS } },
        everyDays: { type: "integer", minimum: 1, maximum: 90 },
        horizonDays: { type: "integer", minimum: 7, maximum: 540 },
        leadDays: { type: "integer", minimum: 0, maximum: 365 },
        cycle: { type: "object", additionalProperties: false, required: ["opensMonth", "closesMonth", "basis", "sourceUrl"], properties: {
          opensMonth: { type: "integer", minimum: 0, maximum: 12 }, closesMonth: { type: "integer", minimum: 0, maximum: 12 },
          basis: { type: "string", maxLength: 200 }, sourceUrl: { type: "string", maxLength: 400 } } },
        prescreen: { type: "array", maxItems: 8, items: { type: "string", minLength: 2, maxLength: 160 } } } } },
    blocked: { type: "string", maxLength: 200 } } } as const;

export type ProposedWatch = {
  key: string; title: string; why: string; factIds: string[]; milestoneIds: string[]; query: string; judge: string; tools: WatchTool[];
  targets: Array<Exclude<WatchTarget, { tool: "site_read" }>>; everyDays: number; horizonDays: number; leadDays: number;
  cycle: { opensMonth: number; closesMonth: number; basis: string; sourceUrl: string }; prescreen: string[];
};
export type WatchesAnswer = { watches: ProposedWatch[]; blocked: string };
export type WatchesContext = { lineId: string; factIds: string[]; milestoneIds: string[] };

const BOARD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/;

/** Repair messages to the needs Skill (model-facing, not interface text). */
/* i18n-ignore-start */
export function watchProposalProblems(answer: WatchesAnswer, context: WatchesContext): string[] {
  const problems: string[] = [];
  const facts = new Set(context.factIds), milestones = new Set(context.milestoneIds);
  const keys = new Set<string>();
  for (const watch of answer.watches ?? []) {
    const label = `「${watch.title}」`;
    if (keys.has(watch.key)) problems.push(`${label} 的 key 重复`);
    keys.add(watch.key);
    const unknownFacts = watch.factIds.filter((id) => !facts.has(id));
    if (unknownFacts.length) problems.push(`${label} 引用了不存在或未确认的事实：${unknownFacts.slice(0, 3).join("、")}`);
    const unknownMilestones = watch.milestoneIds.filter((id) => !milestones.has(id));
    if (unknownMilestones.length) problems.push(`${label} 引用了不存在的里程碑：${unknownMilestones.slice(0, 3).join("、")}`);
    if (!watch.factIds.length && !watch.milestoneIds.length) problems.push(`${label} 没有依据（factIds 与 milestoneIds 都为空），无依据的监视项不收`);
    if ((watch.cycle.opensMonth || watch.cycle.closesMonth) && !/^https:\/\//.test(watch.cycle.sourceUrl)) problems.push(`${label} 写了往年月份，cycle.sourceUrl 必须是写明往年窗口的 https 页面`);
    for (const target of watch.targets) {
      if (!watch.tools.includes(target.tool)) problems.push(`${label} 的 targets 用了 ${target.tool}，tools 里没有它`);
      if (target.tool === "ats_board" && !BOARD.test(target.board)) problems.push(`${label} 的 ATS board「${target.board}」不是公开岗位接口的 board 名（只含字母、数字、-、_、.）`);
      if (target.tool === "web_fetch" && !/^https:\/\/[^\s/]+\.[^\s/]+/.test(target.url)) problems.push(`${label} 的 web_fetch 必须是 https 网址`);
    }
    if (!watch.targets.length && !watch.tools.includes("web_search")) problems.push(`${label} 没有 targets，也没有 web_search，运行时无处可看`);
  }
  if (!(answer.watches ?? []).length && !answer.blocked.trim()) problems.push("watches 为空时 blocked 必须说明原因");
  return problems;
}
/* i18n-ignore-end */

export function validateWatchProposals(value: unknown, context: WatchesContext): WatchesAnswer {
  const answer = value as WatchesAnswer;
  if (!answer || !Array.isArray(answer.watches)) throw Object.assign(new Error("OPPORTUNITY_WATCHES_INVALID"), { detail: "watches must be an array" });
  const problems = watchProposalProblems(answer, context);
  if (problems.length) throw Object.assign(new Error("OPPORTUNITY_WATCHES_INVALID"), { detail: problems.slice(0, 6).join("；") }); // i18n-ignore
  return answer;
}

/** What can be kept of an answer the repairs could not make whole: the watches with no problem of their own. */
export function keepWatchProposals(answer: WatchesAnswer, context: WatchesContext): WatchesAnswer | undefined {
  const watches = answer.watches.filter((watch) => !watchProposalProblems({ watches: [watch], blocked: "-" }, context).length);
  return watches.length ? { watches, blocked: answer.blocked } : undefined;
}

/** A derived watch's id; the `need:` prefix is kept so a migrated need and the same watch derived again are one. */
export const derivedWatchId = (lineId: string, key: string) => `need:${lineId}:${key.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60)}`;

/** A proposal as the ledger keeps it: a cycle's months moved to their next occurrence and the day preparation starts worked back. */
export function watchFromProposal(lineId: string, proposal: ProposedWatch, today: string, now: string,
  origin: "derived" | "scout" = "derived", explore = false): StoredWatch {
  const isCycle = Boolean(proposal.cycle.opensMonth || proposal.cycle.closesMonth);
  const need = needFromProposal(lineId, { key: proposal.key, kind: isCycle ? "cycle" : "stream", title: proposal.title, why: proposal.why, factIds: proposal.factIds,
    milestoneIds: proposal.milestoneIds, window: proposal.cycle, leadDays: proposal.leadDays, eligibility: [], sources: [] }, today);
  const id = origin === "scout" ? `explore:${lineId}:${proposal.key.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60)}` : derivedWatchId(lineId, proposal.key);
  return {
    id, lineId, title: proposal.title, why: proposal.why, origin, basis: { factIds: proposal.factIds, milestoneIds: proposal.milestoneIds, opportunityIds: [] },
    query: proposal.query, tools: proposal.tools, targets: proposal.targets, judge: proposal.judge, explore, everyDays: proposal.everyDays,
    horizonDays: proposal.horizonDays,
    ...(isCycle && need.window ? { cycle: { opens: need.window.opens, closes: need.window.closes, sourceUrl: need.window.sourceUrl ?? "", confirmedAt: now } } : {}),
    state: "proposed", stats: emptyStats(), createdAt: now, updatedAt: now, leadDays: proposal.leadDays, prescreen: proposal.prescreen, weight: 1, strictness: 0,
    ...(need.prepStartsOn ? { prepStartsOn: need.prepStartsOn } : {})
  };
}

/** Normalised title and the Dice coefficient of its character bigrams: how a proposal is matched with what the ledger already holds. */
const squash = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
export function titleSimilarity(a: string, b: string): number {
  const grams = (text: string) => { const s = squash(text); const out: string[] = []; for (let i = 0; i < s.length - 1; i += 1) out.push(s.slice(i, i + 2)); return out; };
  const x = grams(a), y = grams(b);
  if (!x.length || !y.length) return squash(a) === squash(b) && squash(a) ? 1 : 0;
  const pool = [...y];
  let hits = 0;
  for (const gram of x) { const at = pool.indexOf(gram); if (at >= 0) { hits += 1; pool.splice(at, 1); } }
  return (2 * hits) / (x.length + y.length);
}
export const DUPLICATE_SIMILARITY = 0.6;

/**
 * A line's new derivation merged into what is kept. An active, paused or retired watch keeps the person's decision and its stats (the
 * rest follows the new reading); a person's own watch is never replaced; a proposal nobody answered is replaced; a proposal that repeats
 * something done — a retired watch, finished or archived work, a completed milestone (`done`) — is not proposed again (§17.5).
 */
export function mergeWatches(kept: StoredWatch[], lineId: string, fresh: StoredWatch[], done: string[] = []): StoredWatch[] {
  const others = kept.filter((watch) => watch.lineId !== lineId);
  const line = kept.filter((watch) => watch.lineId === lineId);
  const freshById = new Map(fresh.map((watch) => [watch.id, watch]));
  const out = line.flatMap((watch): StoredWatch[] => {
    const next = freshById.get(watch.id);
    if (watch.origin === "person" || watch.origin === "scout" || watch.state === "retired") return [watch];
    if (watch.state === "active" || watch.state === "paused") {
      return [next ? { ...next, origin: watch.origin === "migrated" ? "migrated" : next.origin, state: watch.state, stats: watch.stats, createdAt: watch.createdAt,
        weight: watch.weight, strictness: watch.strictness, ...(watch.radiusMinutes ? { radiusMinutes: watch.radiusMinutes } : {}),
        everyDays: Math.max(next.everyDays, watch.everyDays), prescreen: [...new Set([...next.prescreen, ...watch.prescreen])],
        ...(watch.decidedAt ? { decidedAt: watch.decidedAt } : {}) } : watch];
    }
    return next ? [next] : [];
  });
  const known = new Set(out.map((watch) => watch.id));
  const retiredTitles = [...line.filter((watch) => watch.state === "retired").map((watch) => watch.title), ...done];
  const added = fresh.filter((watch) => !known.has(watch.id)
    && !retiredTitles.some((title) => titleSimilarity(title, watch.title) >= DUPLICATE_SIMILARITY)
    && !out.some((other) => titleSimilarity(other.title, watch.title) >= DUPLICATE_SIMILARITY));
  return [...others, ...out, ...added];
}

// ── Running ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Active and its period passed since the last run (or never run). */
export const watchDue = (watch: StoredWatch, now: Date) => watch.state === "active"
  && (!watch.stats.lastRunAt || now.getTime() - Date.parse(watch.stats.lastRunAt) >= watch.everyDays * DAY - 3_600_000);

/** What a watch's runs are attributed to in the usage ledger (`withUsagePurpose`), so its cost is counted in weighted tokens. */
export const watchPurpose = (watch: Pick<StoredWatch, "id" | "explore">) => `opportunity:${watch.explore ? "explore" : "watch"}:${watch.id}`;
export const SCOUT_PURPOSE = "opportunity:scout";
export const derivePurpose = (lineId: string) => `opportunity:derive:${lineId}`;

/**
 * The 20% share (§17.3) from the usage ledger's sums per purpose: exploration is the scout and every `explore` watch, the whole is
 * every opportunity run. A new exploration starts while the share is under `EXPLORE_SHARE`, or when nothing was explored yet this week
 * (the week's first scout; its own cost then counts against the rest of the week).
 */
export function exploreAccount(rows: Array<{ purpose: string; weighted: number }>): { explore: number; total: number; share: number; allows: boolean } {
  const opportunity = rows.filter((row) => row.purpose.startsWith("opportunity:"));
  const explore = opportunity.filter((row) => row.purpose === SCOUT_PURPOSE || row.purpose.startsWith("opportunity:explore:")).reduce((sum, row) => sum + row.weighted, 0);
  const total = opportunity.reduce((sum, row) => sum + row.weighted, 0);
  const share = total ? explore / total : 0;
  return { explore, total, share, allows: explore === 0 || share < EXPLORE_SHARE };
}

// ── Outcomes, yield and retiring (§17.4) ─────────────────────────────────────────────────────────────────────────────

export const outcomeScore = (outcomes: Partial<Record<OpportunityOutcome, number>>) =>
  Object.entries(outcomes).reduce((sum, [kind, count]) => sum + OUTCOME_WEIGHT[kind as OpportunityOutcome] * (count ?? 0), 0);
/** Weighted outcomes per 10k weighted tokens, plus one so a watch that spent nothing (lists read without a model) is judged on its outcomes. */
export const watchYield = (stats: WatchStats) => outcomeScore(stats.outcomes) / (1 + stats.cost / 10_000);

/** One outcome added to a watch's stats; a positive one moves `lastYieldAt`. */
export function withOutcome(stats: WatchStats, outcome: OpportunityOutcome, at: string): WatchStats {
  return { ...stats, outcomes: { ...stats.outcomes, [outcome]: (stats.outcomes[outcome] ?? 0) + 1 },
    ...(OUTCOME_WEIGHT[outcome] > 0 ? { lastYieldAt: at } : {}) };
}

/**
 * The watches to retire now: active, not the person's own, run at least `RETIRE_AFTER_RUNS` times, yielding under the mean of their
 * line's active watches, and with no positive outcome for `RETIRE_QUIET_DAYS` (counted from its creation when it never had one).
 */
export function retireCandidates(watches: StoredWatch[], now: Date): StoredWatch[] {
  const active = watches.filter((watch) => watch.state === "active");
  return active.filter((watch) => {
    if (watch.origin === "person" || watch.stats.runs < RETIRE_AFTER_RUNS) return false;
    const peers = active.filter((other) => other.lineId === watch.lineId);
    const mean = peers.reduce((sum, other) => sum + watchYield(other.stats), 0) / peers.length;
    const quietSince = watch.stats.lastYieldAt ?? watch.createdAt;
    return watchYield(watch.stats) < mean && now.getTime() - Date.parse(quietSince) >= RETIRE_QUIET_DAYS * DAY;
  });
}

/** Exploration directions for the next scout's prompt (§17.3): explore and scout watches, a direction with nothing to show left out. */
export function scoutDirections(watches: StoredWatch[]): Array<{ title: string; lineId: string; runs: number; score: number; surfaced: number }> {
  return watches.filter((watch) => (watch.explore || watch.origin === "scout") && watch.state !== "proposed")
    .map((watch) => ({ title: watch.title, lineId: watch.lineId, runs: watch.stats.runs, score: outcomeScore(watch.stats.outcomes), surfaced: watch.stats.surfaced }))
    .filter((direction) => !(direction.runs >= 2 && direction.score <= 0));
}

// ── Surfacing: what of the found reaches the person ───────────────────────────────────────────────────────────────────

const HOUR = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)|\b([01]?\d|2[0-3]):([0-5]\d)\b|(上午|下午|晚上)\s*(\d{1,2})/i;
/** The part of the day an opportunity starts in, read from its quoted start; `any` when the quote names no time. */
export function dayPartOf(quote: string): DayPart {
  const match = quote.match(HOUR);
  if (!match) return "any";
  let hour: number;
  if (match[1]) { hour = Number(match[1]) % 12 + (/p/i.test(match[3] ?? "") ? 12 : 0); }
  else if (match[4]) hour = Number(match[4]);
  else hour = Number(match[7]) % 12 + (match[6] === "上午" ? 0 : 12); // i18n-ignore: matched against a page's words
  return hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
}
export const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
export const hostKey = (url: string) => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

export type SurfaceInput = {
  opportunity: Pick<Opportunity, "url" | "startsAt">;
  verdict: { state: string };
  feasibility?: Feasibility | undefined;
  watch?: Pick<StoredWatch, "weight" | "strictness" | "state"> | undefined;
  tuning: WatchTuning;
};
/** Why an opportunity that passed the gates is still held back, or undefined when it may be shown. Code only (§17.4's adjustments). */
export function holdBack(input: SurfaceInput): string | undefined {
  const { opportunity, verdict, feasibility, watch, tuning } = input;
  if (verdict.state === "ineligible") return "ineligible";
  if (feasibility?.state === "infeasible") return "infeasible";
  const host = hostKey(opportunity.url);
  if (tuning.knownHosts.includes(host)) return "known_source";
  if ((tuning.sourceWeights[host] ?? 1) < SOURCE_WEIGHT_FLOOR) return "untrusted_source";
  if (watch && watch.weight < WEIGHT_FLOOR) return "off_topic";
  if (watch && watch.strictness >= 1 && verdict.state === "unknown") return "strict";
  if (opportunity.startsAt?.day) {
    const weekday = weekdayOf(opportunity.startsAt.day), part = dayPartOf(opportunity.startsAt.quote);
    if (tuning.badTimes.some((bad) => bad.weekday === weekday && (bad.part === "any" || part === "any" || bad.part === part))) return "bad_time";
  }
  return undefined;
}

// ── 「少来」 (§17.4) ───────────────────────────────────────────────────────────────────────────────────────────────────

type Translate = (key: string, values?: Record<string, unknown>) => string;
/**
 * One 「少来」: scope `kind` doubles the watch's period and raises its bar; each reason changes its own thing; a note becomes a
 * preference the next derivation reads (written by the caller, whose ref is given back in `undo`). Pure: the caller saves all three.
 */
export function applyLess(input: { feedback: LessFeedback; watch?: StoredWatch | undefined; tuning: WatchTuning; opportunity: Pick<Opportunity, "id" | "url" | "title" | "lineId" | "startsAt">;
  failedRules: string[]; id: string; at: string; t: Translate }): { watch?: StoredWatch | undefined; tuning: WatchTuning; entry: LessEntry } {
  const { feedback, opportunity, t } = input;
  let watch = input.watch;
  let tuning: WatchTuning = { badTimes: [...input.tuning.badTimes], knownHosts: [...input.tuning.knownHosts], sourceWeights: { ...input.tuning.sourceWeights } };
  const changes: string[] = [];
  const undo: LessEntry["undo"] = {};
  const keepWatch = (fields: Partial<StoredWatch>) => {
    if (!watch) return;
    const before: Record<string, unknown> = { ...(undo.watch ?? {}) };
    for (const key of Object.keys(fields)) if (!(key in before)) before[key] = (watch as Record<string, unknown>)[key] ?? null;
    undo.watch = before as LessEntry["undo"]["watch"];
    watch = { ...watch, ...fields, updatedAt: input.at };
  };
  const host = hostKey(opportunity.url);
  if (feedback.scope === "kind" && watch) {
    const everyDays = Math.min(watch.everyDays * 2, 180);
    keepWatch({ everyDays, strictness: watch.strictness + 1 });
    changes.push(t("「{{title}}」改为每 {{days}} 天看一次，门槛提高一级", { title: watch.title, days: everyDays }));
  }
  switch (feedback.reason) {
    case "off_topic":
      if (watch) { const weight = Math.round(watch.weight * 50) / 100; keepWatch({ weight }); changes.push(t("「{{title}}」的权重降到 {{weight}}", { title: watch.title, weight })); }
      break;
    case "bad_time": {
      if (!opportunity.startsAt?.day) { changes.push(t("这条没有写活动时间，没有记下不合适的时段")); break; }
      const entry = { id: input.id, weekday: weekdayOf(opportunity.startsAt.day), part: dayPartOf(opportunity.startsAt.quote) };
      tuning = { ...tuning, badTimes: [...tuning.badTimes, entry] };
      undo.badTimeId = input.id;
      changes.push(t("记下本人在{{weekday}}{{part}}不方便", { weekday: t(WEEKDAY_LABEL[entry.weekday]!), part: t(DAY_PART_LABEL[entry.part]) }));
      break;
    }
    case "too_far":
      if (watch) {
        const radiusMinutes = Math.max(15, Math.round((watch.radiusMinutes ?? LOCAL_MINUTES_MAX) * 0.75));
        keepWatch({ radiusMinutes });
        changes.push(t("「{{title}}」的本地活动单程上限收紧到 {{minutes}} 分钟", { title: watch.title, minutes: radiusMinutes }));
      }
      break;
    case "not_eligible": {
      const rules = input.failedRules.length ? input.failedRules : [t("与「{{title}}」同样的资格要求", { title: opportunity.title })];
      if (watch) { keepWatch({ prescreen: [...new Set([...watch.prescreen, ...rules])].slice(-12) }); changes.push(t("「{{title}}」先筛掉：{{rules}}", { title: watch.title, rules: rules.join(t("；")) })); }
      break;
    }
    case "already_known":
      if (host && !tuning.knownHosts.includes(host)) { tuning = { ...tuning, knownHosts: [...tuning.knownHosts, host] }; undo.knownHost = host; }
      changes.push(t("{{host}} 记为本人已知的来源，那里的不再推", { host }));
      break;
    case "untrusted_source": {
      const before = tuning.sourceWeights[host] ?? null;
      const weight = Math.round((before ?? 1) * 50) / 100;
      tuning = { ...tuning, sourceWeights: { ...tuning.sourceWeights, [host]: weight } };
      undo.sourceWeight = { host, before };
      changes.push(t("{{host}} 的来源权重降到 {{weight}}", { host, weight }));
      break;
    }
    case "not_good_enough":
      if (watch) { keepWatch({ strictness: (watch.strictness) + 1 }); changes.push(t("「{{title}}」的档次下限提高一级", { title: watch.title })); }
      break;
    default: break;
  }
  if (feedback.note?.trim()) changes.push(t("记下本人的话：{{note}}", { note: feedback.note.trim().slice(0, 200) }));
  if (!changes.length) changes.push(t("这一条不再推"));
  const entry: LessEntry = { ...feedback, id: input.id, at: input.at, lineId: opportunity.lineId, title: opportunity.title, changes, undo };
  return { ...(watch ? { watch } : {}), tuning, entry };
}

/** What taking a 「少来」 back puts where it was: only what that one changed. */
export function undoLess(entry: LessEntry, watch: StoredWatch | undefined, tuning: WatchTuning, at: string): { watch?: StoredWatch | undefined; tuning: WatchTuning } {
  const restored = watch && entry.undo.watch ? { ...watch, ...Object.fromEntries(Object.entries(entry.undo.watch).map(([key, value]) => [key, value ?? undefined])), updatedAt: at } as StoredWatch : watch;
  let next = tuning;
  if (entry.undo.badTimeId) next = { ...next, badTimes: next.badTimes.filter((item) => item.id !== entry.undo.badTimeId) };
  if (entry.undo.knownHost) next = { ...next, knownHosts: next.knownHosts.filter((host) => host !== entry.undo.knownHost) };
  if (entry.undo.sourceWeight) {
    const { host, before } = entry.undo.sourceWeight;
    const weights = { ...next.sourceWeights };
    if (before === null) delete weights[host]; else weights[host] = before;
    next = { ...next, sourceWeights: weights };
  }
  return { ...(restored ? { watch: restored } : {}), tuning: next };
}

export const WEEKDAY_LABEL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
export const DAY_PART_LABEL: Record<DayPart, string> = { morning: "上午", afternoon: "下午", evening: "晚上", any: "全天" };
export const LESS_REASON_LABEL: Record<NonNullable<LessFeedback["reason"]>, string> = {
  off_topic: "偏题", bad_time: "时间不合", too_far: "太远", not_eligible: "资格不符", already_known: "已知道", untrusted_source: "来源不可信",
  not_good_enough: "档次不够"
};

// ── The weekly scout's file (§17.3) ──────────────────────────────────────────────────────────────────────────────────────

/** A find as the scout writes it into `scout.json`; code fills in ids, the key and when, and checks every quote against the page. */
export type ScoutFind = { url: string; title: string; organizer: string; kind: "event" | "application"; lineId: string;
  deadlines: Array<{ day: string; quote: string }>; startsAt?: { day: string; quote: string } | undefined;
  cost?: { known: boolean; amount: number; currency: string; quote: string } | undefined; location?: string | undefined;
  eligibility?: EligibilityTerm[] | undefined; needsAccount?: boolean | undefined; materials?: string[] | undefined; consents?: string[] | undefined;
  registrationUrl?: string | undefined; why?: string | undefined };
export type ScoutFile = { opportunities: ScoutFind[]; watches: Array<ProposedWatch & { lineId: string }>; notes: string[] };

/** The scout's file read leniently: anything with the wrong shape is left out rather than failing the whole week's run. */
export function readScoutFile(value: unknown, lineIds: string[]): ScoutFile {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const lines = new Set(lineIds);
  const str = (item: unknown, max = 400) => typeof item === "string" ? item.slice(0, max) : "";
  const dated = (item: unknown) => item && typeof item === "object" && /^\d{4}-\d{2}-\d{2}$/.test(str((item as { day?: unknown }).day))
    ? { day: str((item as { day: string }).day), quote: str((item as { quote?: unknown }).quote, 300) } : undefined;
  const opportunities = (Array.isArray(raw.opportunities) ? raw.opportunities : []).slice(0, 12).flatMap((item): ScoutFind[] => {
    if (!item || typeof item !== "object") return [];
    const find = item as Record<string, unknown>;
    const url = str(find.url), lineId = str(find.lineId, 80);
    if (!/^https:\/\//.test(url) || !lines.has(lineId) || !str(find.title)) return [];
    const startsAt = dated(find.startsAt);
    const terms = (Array.isArray(find.eligibility) ? find.eligibility : []).flatMap((term): EligibilityTerm[] => {
      const value = term as Record<string, unknown>;
      if (!value || typeof value.rule !== "string" || typeof value.quote !== "string") return [];
      const accepts = value.accepts as EligibilityTerm["accepts"] | undefined;
      return [{ dim: (ELIGIBILITY_DIMS as readonly string[]).includes(value.dim as string) ? value.dim as EligibilityTerm["dim"] : "other", rule: value.rule.slice(0, 200), quote: value.quote.slice(0, 300),
        accepts: accepts && Array.isArray(accepts.values) ? accepts : { kind: "text", values: [], min: -1, max: -1 } }];
    });
    const cost = find.cost as ScoutFind["cost"];
    return [{ url, lineId, title: str(find.title, 200), organizer: str(find.organizer, 120), kind: find.kind === "event" ? "event" : "application",
      deadlines: (Array.isArray(find.deadlines) ? find.deadlines : []).map(dated).filter((item): item is { day: string; quote: string } => Boolean(item)),
      ...(startsAt ? { startsAt } : {}), ...(cost && typeof cost === "object" ? { cost } : {}), location: str(find.location, 200), eligibility: terms,
      needsAccount: find.needsAccount === true, materials: (Array.isArray(find.materials) ? find.materials : []).map((m) => str(m, 120)).filter(Boolean),
      consents: (Array.isArray(find.consents) ? find.consents : []).map((c) => str(c, 300)).filter(Boolean), registrationUrl: str(find.registrationUrl), why: str(find.why, 300) }];
  });
  const watches = (Array.isArray(raw.watches) ? raw.watches : []).slice(0, 6).flatMap((item): ScoutFile["watches"] => {
    const value = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const lineId = str(value.lineId, 80), title = str(value.title, 80), query = str(value.query, 600);
    if (!lines.has(lineId) || !title || !query) return [];
    const tools = (Array.isArray(value.tools) ? value.tools : []).filter((tool): tool is WatchTool => (WATCH_TOOLS as readonly string[]).includes(tool as string));
    const ids = (field: unknown) => (Array.isArray(field) ? field : []).map((entry) => str(entry, 160)).filter(Boolean);
    const cycle = (value.cycle && typeof value.cycle === "object" ? value.cycle : {}) as Record<string, unknown>;
    const int = (field: unknown, min: number, max: number, fallback: number) => typeof field === "number" && Number.isFinite(field) ? Math.min(max, Math.max(min, Math.round(field))) : fallback;
    return [{ lineId, key: str(value.key, 60) || title, title, why: str(value.why, 300), factIds: ids(value.factIds), milestoneIds: ids(value.milestoneIds), query,
      judge: str(value.judge, 400) || str(value.why, 300), tools: tools.length ? tools : ["web_search"],
      targets: (Array.isArray(value.targets) ? value.targets : []).filter((target): target is ProposedWatch["targets"][number] =>
        Boolean(target) && typeof target === "object" && (WATCH_TOOLS as readonly string[]).includes((target as { tool?: string }).tool ?? "") && (target as { tool?: string }).tool !== "site_read"),
      everyDays: int(value.everyDays, 1, 90, 7), horizonDays: int(value.horizonDays, 7, 540, 120), leadDays: int(value.leadDays, 0, 365, 14),
      cycle: { opensMonth: int(cycle.opensMonth, 0, 12, 0), closesMonth: int(cycle.closesMonth, 0, 12, 0), basis: str(cycle.basis, 200), sourceUrl: str(cycle.sourceUrl) },
      prescreen: ids(value.prescreen).slice(0, 8) }];
  });
  return { opportunities, watches, notes: (Array.isArray(raw.notes) ? raw.notes : []).map((note) => str(note, 300)).filter(Boolean).slice(0, 10) };
}
