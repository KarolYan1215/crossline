/**
 * The opportunity agent's shared contract (docs/opportunity-agent.md §16, decided 2026-11-01). Two tracks are built against it in
 * parallel: discovery (needs → sources → eligibility → the morning brief and the offer card) and form filling (the application profile,
 * the page engine, checks and submission). They meet only through `Opportunity` records and the `FormRun` queue, so this file holds
 * types and fixed vocabularies, nothing either track decides on its own.
 */

/** A need worked out from a line's long-term goal: an outside gate the goal has to pass that the person has not planned for (§5). */
export type OpportunityNeedKind = "cycle" | "stream";
export type OpportunityNeed = {
  id: string;
  lineId: string;
  kind: OpportunityNeedKind;
  title: string;
  why: string;
  /** Confirmed fact ids and milestone ids it rests on; a need with none is not kept. */
  factIds: string[];
  milestoneIds: string[];
  /** For a cycle: when it usually opens and closes, from a page that says so. For a stream: the period worth watching. */
  window?: { opens?: string; closes?: string; basis: string; sourceUrl?: string } | undefined;
  /** How long before the deadline preparation has to start. */
  leadDays: number;
  /** Eligibility assumed when the need was made, used only to pre-screen; the real check is on each opportunity's own terms. */
  eligibility: EligibilityRule[];
  sources: NeedSource[];
  state: "proposed" | "tracking" | "declined";
};

export type NeedSource =
  | { kind: "ats"; provider: "greenhouse" | "lever" | "ashby"; board: string; query?: string | undefined }
  | { kind: "deadline_list"; list: "ccfddl" | "ai-deadlines"; query: string }
  | { kind: "events"; site: string; query: string }
  | { kind: "mail"; from?: string | undefined; query: string }
  | { kind: "web"; query: string }
  | { kind: "site_read"; host: string; path: string };

/** The dimensions eligibility is judged on. A term that maps to none of them is put to the person as a question. */
export const ELIGIBILITY_DIMS = ["degree_stage", "year", "graduation_year", "citizenship", "work_authorization", "region", "age",
  "school", "field", "team_size", "company_stage", "other"] as const;
export type EligibilityDim = (typeof ELIGIBILITY_DIMS)[number];
/** One term of an opportunity's eligibility, with the sentence of its page it was read from. */
export type EligibilityRule = { dim: EligibilityDim; rule: string; quote: string };

export type DatedQuote = { day: string; quote: string };

export type Opportunity = {
  id: string;
  /** Dedupe key across sources (host + normalized title + first deadline). */
  key: string;
  needId?: string | undefined;
  lineId: string;
  kind: "event" | "application";
  title: string;
  organizer: string;
  url: string;
  /** The host the registration or application form lives on; the form engine opens nothing else. */
  registrationHost: string;
  deadlines: DatedQuote[];
  startsAt?: DatedQuote | undefined;
  cost: { amount: number; currency: string; quote: string } | null;
  location?: string | undefined;
  eligibility: EligibilityRule[];
  needsAccount: boolean;
  materials: string[];
  /** Terms the form asks the person to agree to, listed on the offer card so the person's 报名 covers them. */
  consents: string[];
  foundVia: NeedSource["kind"];
  foundAt: string;
};

export type EligibilityVerdict =
  | { state: "eligible"; basis: Array<{ dim: EligibilityDim; factId?: string | undefined; slot?: string | undefined }> }
  | { state: "unknown"; questions: Array<{ dim: EligibilityDim; question: string }> }
  | { state: "ineligible"; failed: Array<{ dim: EligibilityDim; rule: string; why: string }> };

/** What the person chose on the offer card (§8). `apply` writes an approved milestone; `register` queues a `FormRun`. */
export type OpportunityDecision = "register" | "apply" | "plan" | "decline" | "later";

/**
 * The application profile's slots (§12). A sensitive slot's value lives only in the worker's secret store (`apply-<slot>`), never in
 * the ledger, an export, a backup or the ledger sync; a model only ever writes `{{profile.<slot>}}` and the engine fills it in.
 */
export const APPLICATION_SLOTS = {
  full_name: false, preferred_name: false, email: false, school: false, major: false, degree_stage: false, graduation_year: false,
  city: false, country: false, website: false, github: false, resume: false,
  phone: true, birth_date: true, student_id: true, address: true, id_number: true, passport_number: true,
} as const satisfies Record<string, boolean>;
export type ApplicationSlot = keyof typeof APPLICATION_SLOTS;
export const isSensitiveSlot = (slot: ApplicationSlot): boolean => APPLICATION_SLOTS[slot];
export const profilePlaceholder = (slot: ApplicationSlot): string => `{{profile.${slot}}}`;

/** One proposed action on a form page (§10.2); the engine judges each before doing it (§10.3). */
export type FormAction = {
  op: "fill" | "select" | "check" | "upload" | "next" | "submit";
  /** role + accessible name of an element in this page's snapshot. */
  target: { role: string; name: string };
  value?: { slot: ApplicationSlot } | { draft: string } | { text: string } | undefined;
  why: string;
};

export const FORM_RUN_STATES = ["queued", "filling", "waiting_person", "ready_to_submit", "submitted", "confirmed", "stopped"] as const;
export type FormRunState = (typeof FORM_RUN_STATES)[number];
export type FormStop = "login" | "captcha" | "payment" | "missing_slot" | "essay" | "verify_failed" | "layout_changed" | "site_hold"
  | "not_allowed" | "engine_failed";
export type FormRun = {
  id: string;
  opportunityId: string;
  host: string;
  state: FormRunState;
  pageNo: number;
  stoppedFor?: FormStop | undefined;
  /** What was filled and whether reading it back matched (§10.6); a sensitive value is never kept, only that it matched. */
  filled: Array<{ pageNo: number; target: string; slot?: ApplicationSlot | undefined; verified: boolean }>;
  screenshots: string[];
  /** Which engine did each page: our own, or a fallback (§10.7). */
  engines: Array<{ pageNo: number; engine: "own" | "stagehand" | "browser-use" }>;
  submittedBy?: "system" | "person" | undefined;
};
