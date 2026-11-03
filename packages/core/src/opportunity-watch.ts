/**
 * The opportunity agent's second contract (docs/opportunity-agent.md §17, decided 2026-11-02). It replaces the fixed source enum with
 * watches the model proposes freely, adds a weekly free scout, a code-kept flywheel ledger and a time–space feasibility verdict that
 * code computes. Three tracks are built against it in parallel (§17.9): watches and the scout, the time–space engine, and the synthetic
 * world tests. This file holds types and fixed vocabularies only.
 */
import type { Opportunity } from "./opportunity";

/** Where a watch came from. `migrated` is an `OpportunityNeed` from before §17; `person` is one the person wrote or edited. */
export type WatchOrigin = "migrated" | "derived" | "scout" | "person";
export const WATCH_STATES = ["proposed", "active", "paused", "retired"] as const;
export type WatchState = (typeof WATCH_STATES)[number];

/**
 * A watch: a standing query plus how to judge what it finds, chosen by the model from the line's goal, milestones and progress. Nothing
 * here names a source kind: `tools` lists any of the agent's tools (`WATCH_TOOLS`) and `query` says in words what to look for and where.
 */
export type Watch = {
  id: string;
  lineId: string;
  title: string;
  /** Why this is worth watching, in the person's terms; shown on the line card. */
  why: string;
  origin: WatchOrigin;
  /** Confirmed fact ids, milestone ids and earlier opportunity ids it rests on; a derived watch with none is not kept. */
  basis: { factIds: string[]; milestoneIds: string[]; opportunityIds: string[] };
  /** What to look for and where, in words. Free: a page, a list, a person's lab page, a city's events this month. */
  query: string;
  tools: WatchTool[];
  /** How to tell a find worth the person's attention from noise, in words; the code-checked gates of §7 and §17.5 come on top. */
  judge: string;
  /** Exploration outside the person's attention domain (§17.3); counted against the 20% share. */
  explore: boolean;
  everyDays: number;
  /** How far ahead finds matter: a cycle that opens in March is watched from the autumn before. */
  horizonDays: number;
  /** For a yearly cycle: the last confirmed window with its source, never projected forward as a fact (§17.2). */
  cycle?: { opens?: string | undefined; closes?: string | undefined; sourceUrl: string; confirmedAt: string } | undefined;
  state: WatchState;
  stats: WatchStats;
};

/** The tools a watch or the scout may use. Adapters from track A are tools now, not the shape of the pipeline. */
export const WATCH_TOOLS = ["web_search", "web_fetch", "ats_board", "deadline_list", "devpost", "events_site", "mail_search", "site_read",
  "calendar", "geo"] as const;
export type WatchTool = (typeof WATCH_TOOLS)[number];

/** What became of something surfaced. Outcomes, not ratings, drive the flywheel (§17.4). */
export const OPPORTUNITY_OUTCOMES = ["surfaced", "ignored", "less", "declined", "later", "planned", "task", "submitted", "accepted",
  "rejected", "attended"] as const;
export type OpportunityOutcome = (typeof OPPORTUNITY_OUTCOMES)[number];
/** How much each outcome counts towards a watch's yield; a rejection still means the find was right for the person. */
export const OUTCOME_WEIGHT: Record<OpportunityOutcome, number> = {
  surfaced: 0, ignored: -0.2, less: -1, declined: -0.5, later: 0.2, planned: 1, task: 1, submitted: 2, accepted: 3, rejected: 1.5,
  attended: 2.5,
};

/** Kept by code, never by the model: what a watch cost and what it produced (the bookkeeping Krishnamurthy et al. found models need). */
export type WatchStats = {
  runs: number;
  found: number;
  surfaced: number;
  outcomes: Partial<Record<OpportunityOutcome, number>>;
  /** Weighted tokens (`weightedTokens` in quota-saver) spent on this watch's runs. */
  cost: number;
  lastRunAt?: string | undefined;
  lastYieldAt?: string | undefined;
};

/** 「少来」 (§17.4): one tap lowers how often this kind comes, or names a reason, or adds an optional sentence. */
export const LESS_REASONS = ["off_topic", "bad_time", "too_far", "not_eligible", "already_known", "untrusted_source",
  "not_good_enough"] as const;
export type LessReason = (typeof LESS_REASONS)[number];
export type LessFeedback = {
  opportunityId: string;
  watchId?: string | undefined;
  scope: "item" | "kind";
  reason?: LessReason | undefined;
  note?: string | undefined;
};

/** Where the person will be on a day (§17.6). Device positions are kept to about 1 km (two decimals), never as a track. */
export type PersonPlace = {
  from: string;
  to: string;
  city: string;
  country: string;
  lat?: number | undefined;
  lon?: number | undefined;
  source: "fact" | "calendar" | "mail" | "device";
  ref: string;
};

export type EventPlace = {
  mode: "online" | "in_person" | "hybrid" | "unknown";
  city?: string | undefined;
  country?: string | undefined;
  lat?: number | undefined;
  lon?: number | undefined;
  quote: string;
};

/** Local events are kept to one hour each way; conferences, competitions and internships have no limit but carry their cost (§17.6). */
export const LOCAL_MINUTES_MAX = 60;
/**
 * `travelDays` (days spent getting there before the event, counted back from it) and `costTier` were added by track ② (additive): the card
 * shows them for conferences, competitions and internships, which have no distance limit but carry their cost (§17.6).
 */
export type TravelEstimate = { km: number; mode: "walk" | "transit" | "drive" | "rail" | "flight"; minutesOneWay: number; nights: number;
  travelDays?: number | undefined; costTier?: TravelCostTier | undefined };
export type TravelCostTier = "low" | "medium" | "high";

/**
 * What kind of thing an opportunity is, for the radius rule (§17.6; added by track ②, additive). Only `local_event` is held to
 * `LOCAL_MINUTES_MAX`; the reader sets it, and an opportunity without one is classified by `opportunityCategory`.
 */
export const OPPORTUNITY_CATEGORIES = ["local_event", "conference", "competition", "internship", "program", "other"] as const;
export type OpportunityCategory = (typeof OPPORTUNITY_CATEGORIES)[number];
export type VisaCheck = {
  needed: boolean | "unknown";
  leadDays: number;
  sourceUrl?: string | undefined;
  quote?: string | undefined;
  checkedAt: string;
  verified: boolean;
};
/** Default lead when no official page could be read; marked unverified on the card. */
export const VISA_LEAD_FALLBACK_DAYS = 60;
export const VISA_CACHE_DAYS = 90;

export type CalendarClash = { blockId: string; title: string; start: string; end: string; fixed: boolean };

/**
 * Computed in code before anything reaches the person. `infeasible` is never shown (expired, can no longer be prepared in time, too far
 * for a local event, a visa that cannot arrive). `conflict` is shown at once with the clash explained; the person may agree to move a
 * fixed arrangement, and how to move it is then asked (§17.7).
 */
export type Feasibility =
  | { state: "feasible"; place?: PersonPlace | undefined; travel?: TravelEstimate | undefined; visa?: VisaCheck | undefined;
    latestStart: string }
  | { state: "conflict"; clashes: CalendarClash[]; place?: PersonPlace | undefined; travel?: TravelEstimate | undefined;
    visa?: VisaCheck | undefined; latestStart: string }
  | { state: "infeasible"; reasons: Array<{ code: InfeasibleCode; detail: string }> };
export type InfeasibleCode = "expired" | "no_time_to_prepare" | "too_far" | "visa_too_late" | "no_free_time" | "place_unknown";

/** What the weekly free scout hands back (§17.3): finds go through the same gates; watches are proposals the person keeps or drops. */
export type ScoutResult = {
  opportunities: Opportunity[];
  watches: Array<Omit<Watch, "id" | "state" | "stats" | "origin">>;
  notes: string[];
};

/** Share of the opportunity agent's weekly weighted tokens spent outside the person's attention domain. */
export const EXPLORE_SHARE = 0.2;
/** A watch whose yield per cost stays under its line's mean over this many runs, with no outcome for `RETIRE_QUIET_DAYS`, retires. */
export const RETIRE_AFTER_RUNS = 4;
export const RETIRE_QUIET_DAYS = 60;
