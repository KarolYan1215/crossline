import { createHash } from "node:crypto";
import {
  CANDIDATES_PER_NEED, CCFDDL_URL, NEEDS_PERIOD_DAYS, OPPORTUNITY_NEEDS_SCHEMA, OPPORTUNITY_READING_SCHEMA, PAGES_PER_READING, POLL_PERIOD_HOURS,
  aiDeadlines, aiDeadlinesUrl, applicantFrom, boardUrl, ccfddlDeadlines, checkReadItem, devpostHackathons, judgeEligibility, keepOpportunityNeeds,
  needFromProposal, opportunityFromListed, opportunityFromRead, parsePostings, tFor, validateOpportunityNeeds, validateOpportunityReading,
  type NeedSource, type NeedsAnswer, type NeedsContext, type ReadItem, type ReadingAnswer, type StoredNeed
} from "@crossline/core";
import { runCodexSkill, webResearchBlocker, type CodexRpcBoundary } from "@crossline/codex";
import { rejudgeOpportunities, saveLineNeeds, scoutNeeds, startConfirmedFor, type CrosslineStore } from "@crossline/db";
import { readLineSpecs } from "@crossline/identity-packs";
import { parse as parseYaml } from "yaml";
import { claimedTitleMatches } from "./diligence";
import { identityLines } from "./lines";
import { localeOf } from "./locale";
import { ownerOf, runtimeOwner } from "./owner";
import { defaultSafeGetDeps, htmlToText, safeGet, type SafeGetDeps } from "./safe-fetch";

/**
 * The opportunity agent's discovery chain on the worker (docs/opportunity-agent.md §5–7, track A): needs worked out per line by Skill
 * `crossline-opportunity-needs`, each tracked need's sources polled daily (job boards and deadline lists without a model), found pages read
 * by `crossline-opportunity-reader` into quoted records, and eligibility judged by code. Only the machine owner's workspace runs it.
 */

export const OPPORTUNITY_NEEDS = "crossline:crossline-opportunity-needs";
export const OPPORTUNITY_READER = "crossline:crossline-opportunity-reader";
export const NEEDS_DERIVED = "opportunity.needs.derived";
/** When each tracked need was last polled (`{ [needId]: iso }`), and the pages already read (`{ [url]: day }`) so a posting is read once. */
export const POLLED_SETTING = "opportunity.polled";
export const SEEN_SETTING = "opportunity.seen";
/** Opportunities the mail triage found, waiting to be read (`MailCandidate[]`). */
export const MAIL_CANDIDATES_SETTING = "opportunity.mailCandidates";
export type MailCandidate = { key: string; lineId: string; subject: string; from: string; text: string; url: string; at: string };

const READ_AGAIN_DAYS = 30;
const PAGE_CHARS = 12_000;

const NEEDS_INSTRUCTIONS = "Work out which outside gates this line's long-term goal has to pass that the person has not planned for: application "
  + "cycles that open about the same months each year, and streams of events worth watching. Rest each on the given facts or milestones by id. "
  + "Search the web for when each opened and closed in past years and where it is announced; cite only pages you opened; never invent a job "
  + "board, a month or a page. Fewer real needs beat many generic ones; none is a valid answer. Return raw JSON only.";
const READER_INSTRUCTIONS = "Read each given page into one record per opening it holds. Copy every deadline, fee and eligibility term from the page "
  + "verbatim into its quote; code checks each quote against the page and judges eligibility itself. A page with no opening of the kind the need "
  + "is about gets no item. Return raw JSON only.";
const SEARCH_INSTRUCTIONS = "Search the web for current openings matching the need (the query is given). Return at most five, each with the url "
  + "of the page that states it; copy every deadline, fee and eligibility term from that page verbatim — the page is opened and every quote "
  + "checked against it. Leave pageId empty. Return raw JSON only.";

type Clients = { client: () => CodexRpcBoundary | undefined; cwd: string; http?: SafeGetDeps; now?: () => Date; webBlocker?: typeof webResearchBlocker };
const zoneOf = (store: CrosslineStore, workspaceId: string): string => {
  try { return (JSON.parse(store.getSetting(workspaceId, "schedule.preferences") ?? "{}") as { timeZone?: string }).timeZone || "America/Chicago"; }
  catch { return "America/Chicago"; }
};
const readJson = <T>(store: CrosslineStore, workspaceId: string, key: string, fallback: T): T => {
  try { const raw = store.getSetting(workspaceId, key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
};

// ── ① Needs ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a line's needs rest on: its goal and its live milestones. A change is a reason to work them out again. */
function lineBasis(store: CrosslineStore, workspaceId: string, lineId: string): string {
  const spec = readLineSpecs((key) => store.getSetting(workspaceId, key))?.find((line) => line.id === lineId);
  const milestones = latestMilestones(store, workspaceId, lineId).map((item) => `${item.id}:${item.title}:${item.status}`).sort();
  return createHash("sha256").update(JSON.stringify([spec?.goal ?? "", spec?.goals ?? [], milestones])).digest("hex").slice(0, 16);
}
function latestMilestones(store: CrosslineStore, workspaceId: string, lineId: string) {
  const latest = new Map<string, ReturnType<CrosslineStore["listMilestones"]>[number]>();
  for (const milestone of store.listMilestones(workspaceId)) if (milestone.identityId === lineId) latest.set(milestone.id, milestone);
  return [...latest.values()].filter((item) => item.status === "approved" || item.status === "draft");
}

type DerivedRun = { lineId: string; at: string; basis: string; code?: string };
const derivedRuns = (store: CrosslineStore, workspaceId: string): DerivedRun[] =>
  store.listEvents(workspaceId, { type: NEEDS_DERIVED }).map((event) => event.payload as DerivedRun);

/**
 * The lines whose needs are due (§5): once the account is set up (the interview complete or 开始使用 pressed, the same as a line's first
 * skill search) every line never derived, a line added later, a line whose goal or milestones changed since, and every line monthly. A
 * derivation the runtime or the quota stopped is tried again the next day.
 */
export function needsDue(store: CrosslineStore, workspaceId: string, now = new Date()): string[] {
  const interview = store.listOnboardingSessions(workspaceId).find((session) => !session.id.startsWith("line-") && session.state === "complete");
  if (!interview && !startConfirmedFor(store, workspaceId)) return [];
  const runs = derivedRuns(store, workspaceId);
  return identityLines(store, workspaceId).map((line) => line.id).filter((lineId) => {
    const mine = runs.filter((run) => run.lineId === lineId);
    const last = mine.at(-1);
    if (last?.code) return now.getTime() - Date.parse(last.at) >= 86_400_000;
    const done = mine.filter((run) => !run.code).at(-1);
    if (!done) return true;
    return done.basis !== lineBasis(store, workspaceId, lineId) || now.getTime() - Date.parse(done.at) >= NEEDS_PERIOD_DAYS * 86_400_000;
  });
}

const factId = (fact: { identityId: string; projectId: string; slot: string }) => `${fact.identityId}/${fact.projectId}/${fact.slot}`;

/** One line's needs worked out and merged into what is kept; the new proposals become 「跟踪 / 不要」 cards on the web. */
export async function deriveNeeds(store: CrosslineStore, workspaceId: string, lineId: string, deps: Clients): Promise<{ proposed: number } | { blocked: string }> {
  const now = deps.now?.() ?? new Date();
  const record = (code?: string, count = 0) => store.appendEvent({ ownerId: ownerOf(store, workspaceId), workspaceId, idempotencyKey: `${NEEDS_DERIVED}:${lineId}:${now.toISOString()}`,
    type: NEEDS_DERIVED, entityId: lineId, payload: { lineId, at: now.toISOString(), basis: lineBasis(store, workspaceId, lineId), count, ...(code ? { code } : {}) } });
  const client = deps.client();
  if (!client) { record("CODEX_SUPERVISOR_UNAVAILABLE"); return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" }; }
  const web = (deps.webBlocker ?? webResearchBlocker)();
  if (web) { record(web.code); return { blocked: web.code }; }
  const spec = readLineSpecs((key) => store.getSetting(workspaceId, key))?.find((line) => line.id === lineId);
  const pack = identityLines(store, workspaceId).find((line) => line.id === lineId);
  const facts = store.listProfileFacts(workspaceId).filter((fact) => fact.status === "confirmed" && (fact.identityId === lineId || fact.identityId === "person")
    && !fact.value.startsWith("假设") // i18n-ignore: the interview's prefix for an assumption
    // A course's dated items and step answers say nothing about openings and, on a real research line, filled the whole budget before
    // the line's own facts (what, stage, positioning) were reached; the person's and the line's own facts go first.
    && !/^(date_|step_answer_)/.test(fact.slot))
    .sort((a, b) => Number(Boolean(a.projectId)) - Number(Boolean(b.projectId)));
  const milestones = latestMilestones(store, workspaceId, lineId);
  const anchors = new Map(store.listMilestoneAnchors(workspaceId).map((anchor) => [anchor.milestoneId, anchor.deadline]));
  const kept = scoutNeeds(store, workspaceId).filter((need) => need.lineId === lineId && need.state !== "proposed");
  const today = now.toISOString().slice(0, 10);
  const input = {
    version: "crossline.opportunity-needs.v1", today, timeZone: zoneOf(store, workspaceId),
    line: { id: lineId, name: pack?.label ?? lineId, goal: spec?.goals?.[0] ?? spec?.goal ?? "", goalParts: spec?.goalParts ?? [], hard: Boolean(spec?.hard) },
    facts: facts.slice(0, 80).map((fact) => ({ id: factId(fact), value: fact.value.slice(0, 200) })),
    milestones: milestones.map((item) => ({ id: item.id, title: item.title, status: item.status, deadline: anchors.get(item.id) ?? "" })),
    kept: kept.map((need) => ({ key: need.id.split(":").at(-1), title: need.title, state: need.state })),
    declined: store.listPreferences(workspaceId).filter((pref) => pref.source === "opportunity_declined" && (pref.scope === lineId || pref.scope === "all")).map((pref) => pref.text)
  };
  const context: NeedsContext = { lineId, factIds: input.facts.map((fact) => fact.id), milestoneIds: input.milestones.map((item) => item.id) };
  const result = await runCodexSkill<NeedsAnswer>(client, input, {
    skillName: OPPORTUNITY_NEEDS, cwd: deps.cwd, developerInstructions: NEEDS_INSTRUCTIONS, outputSchema: OPPORTUNITY_NEEDS_SCHEMA, prepareInput: () => input,
    allowWebSearch: true, validateOutput: (output) => validateOpportunityNeeds(output, context), softAccept: (_rejection, output) => keepOpportunityNeeds(output as NeedsAnswer, context),
    onAudit: () => {}, timeoutMs: 60 * 60_000
  });
  if (!result.ok) { record(result.blocker.code); return { blocked: result.blocker.code }; }
  const http = deps.http ?? defaultSafeGetDeps();
  const t = tFor(localeOf(store, workspaceId));
  const fresh: StoredNeed[] = [];
  for (const proposal of result.output.needs) {
    let window = proposal.window;
    // The page a cycle's months rest on is opened; one that does not open leaves the months as an unverified guess, said so.
    if (window.sourceUrl) {
      const page = await safeGet(window.sourceUrl, http, { maxBytes: 3_000_000, timeoutMs: 20_000 }).catch(() => undefined);
      if (!page?.ok) window = { ...window, sourceUrl: "", basis: t("未能自动核实：{{basis}}", { basis: window.basis }) };
    }
    fresh.push({ ...needFromProposal(lineId, { ...proposal, window }, today), derivedAt: now.toISOString() });
  }
  const before = new Set(scoutNeeds(store, workspaceId).map((need) => need.id));
  const after = saveLineNeeds(store, workspaceId, lineId, fresh);
  const proposed = after.filter((need) => need.lineId === lineId && need.state === "proposed" && !before.has(need.id)).length;
  record(undefined, fresh.length);
  return { proposed };
}

// ── ② Sources ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Tracked needs whose sources were not looked at in the last day. */
export function needsToPoll(store: CrosslineStore, workspaceId: string, now = new Date()): StoredNeed[] {
  const polled = readJson<Record<string, string>>(store, workspaceId, POLLED_SETTING, {});
  return scoutNeeds(store, workspaceId).filter((need) => need.state === "tracking"
    && (!polled[need.id] || now.getTime() - Date.parse(polled[need.id]!) >= POLL_PERIOD_HOURS * 3_600_000));
}

type Page = { pageId: string; url: string; text: string; via: NeedSource["kind"] };
const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
async function getText(url: string, http: SafeGetDeps, types?: string[]): Promise<string | undefined> {
  const page = await safeGet(url, http, { maxBytes: 5_000_000, timeoutMs: 30_000, ...(types ? { types } : {}) }).catch(() => undefined);
  return page?.ok ? decode(page.bytes) : undefined;
}

/**
 * One tracked need's sources looked at (§6). A job board and a deadline list are read without a model: a listed conference deadline is
 * kept at once (a call for papers has no terms), a posting goes to the reader for its terms. Events pages and mail go to the reader; a
 * `web` source and Luma (whose listing has no public query) are searched by the reader on the open web, and every page it names is opened
 * and its quotes checked here. Returns how many opportunities were kept and how many are new.
 */
export async function pollNeed(store: CrosslineStore, workspaceId: string, need: StoredNeed, deps: Clients): Promise<{ kept: number; fresh: number; blocked?: string }> {
  const now = deps.now?.() ?? new Date();
  const today = now.toISOString().slice(0, 10);
  const http = deps.http ?? defaultSafeGetDeps();
  const seen = readJson<Record<string, string>>(store, workspaceId, SEEN_SETTING, {});
  const unseen = (url: string) => !seen[url] || now.getTime() - Date.parse(seen[url]!) >= READ_AGAIN_DAYS * 86_400_000;
  const applicant = applicantFrom(store.listProfileFacts(workspaceId));
  const locale = localeOf(store, workspaceId);
  const idOf = (key: string) => `opp-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
  let kept = 0, fresh = 0;
  const keep = (opportunity: ReturnType<typeof opportunityFromListed>, terms: ReadItem["eligibility"]) => {
    if (opportunity.deadlines.length && opportunity.deadlines.every((item) => item.day < today)) return;
    const saved = store.saveOpportunity(workspaceId, { opportunity, terms, verdict: judgeEligibility(terms, applicant, locale) }, now.toISOString());
    kept += 1;
    if (saved.inserted) fresh += 1;
  };
  const pages: Page[] = [];
  const searches: Array<{ query: string; via: NeedSource["kind"] }> = [];
  for (const source of need.sources) {
    if (pages.length >= CANDIDATES_PER_NEED) break;
    try {
      if (source.kind === "ats") {
        const body = await getText(boardUrl(source.provider, source.board), http, ["application/json"]);
        if (!body) continue;
        for (const posting of parsePostings(source.provider, JSON.parse(body), source.query ?? "")) {
          if (!unseen(posting.url) || pages.length >= CANDIDATES_PER_NEED) continue;
          pages.push({ pageId: `p${pages.length + 1}`, url: posting.url, via: "ats",
            text: [posting.title, posting.location, posting.deadline?.quote ?? "", posting.text].filter(Boolean).join("\n").slice(0, PAGE_CHARS) });
        }
      } else if (source.kind === "deadline_list") {
        const yaml = source.list === "ccfddl" ? await getText(CCFDDL_URL, http, ["text/yaml", "application/x-yaml", "text/plain"])
          : await getText(aiDeadlinesUrl(source.query), http, ["text/plain", "text/yaml", "application/x-yaml"]);
        if (!yaml) continue;
        const listed = source.list === "ccfddl" ? ccfddlDeadlines(parseYaml(yaml), source.query, today) : aiDeadlines(parseYaml(yaml), today);
        for (const item of listed.slice(0, 4)) keep(opportunityFromListed(item, { lineId: need.lineId, needId: need.id, foundAt: now.toISOString(), idOf }), []);
      } else if (source.kind === "events" && source.site === "devpost") {
        const body = await getText(`https://devpost.com/api/hackathons?search=${encodeURIComponent(source.query)}&status[]=upcoming&status[]=open`, http, ["application/json"]);
        if (!body) { searches.push({ query: `site:devpost.com ${source.query}`, via: "events" }); continue; }
        for (const hackathon of devpostHackathons(JSON.parse(body))) {
          if (!unseen(hackathon.url) || pages.length >= CANDIDATES_PER_NEED) continue;
          const html = await getText(hackathon.url, http);
          if (html) pages.push({ pageId: `p${pages.length + 1}`, url: hackathon.url, via: "events", text: htmlToText(html).slice(0, PAGE_CHARS) });
        }
      } else if (source.kind === "events") {
        searches.push({ query: `site:${source.site === "luma" ? "lu.ma" : source.site} ${source.query}`, via: "events" });
      } else if (source.kind === "web") {
        searches.push({ query: source.query, via: "web" });
      }
    } catch { /* one source failing does not stop the others */ }
  }
  // Mail the triage marked as an opportunity of this line (mailbox.ts), read like a page; the mail is the page.
  const mail = readJson<MailCandidate[]>(store, workspaceId, MAIL_CANDIDATES_SETTING, []);
  const mine = mail.filter((item) => item.lineId === need.lineId || !item.lineId).slice(0, Math.max(0, PAGES_PER_READING - pages.length));
  for (const item of mine) pages.push({ pageId: `p${pages.length + 1}`, url: item.url, via: "mail", text: `${item.subject}\n${item.from}\n${item.text}`.slice(0, PAGE_CHARS) });
  let blocked: string | undefined;
  if (pages.length) {
    const read = await readPages(store, workspaceId, need, pages, deps, now);
    if ("blocked" in read) blocked = read.blocked;
    else {
      for (const { item, via } of read.items) keep(opportunityFromRead(item, { lineId: need.lineId, needId: need.id, foundVia: via, foundAt: now.toISOString(), idOf }), item.eligibility);
      for (const page of pages) if (page.url) seen[page.url] = now.toISOString();
      if (mine.length) store.setSetting(workspaceId, MAIL_CANDIDATES_SETTING, JSON.stringify(mail.filter((item) => !mine.includes(item))));
    }
  }
  for (const search of searches.slice(0, 1)) {
    if (blocked) break;
    const found = await searchWeb(store, workspaceId, need, search.query, deps, now, http);
    if ("blocked" in found) { blocked = found.blocked; break; }
    for (const { item } of found.items) {
      if (!unseen(item.url)) continue;
      seen[item.url] = now.toISOString();
      keep(opportunityFromRead(item, { lineId: need.lineId, needId: need.id, foundVia: search.via, foundAt: now.toISOString(), idOf }), item.eligibility);
    }
  }
  store.setSetting(workspaceId, SEEN_SETTING, JSON.stringify(Object.fromEntries(Object.entries(seen).slice(-2000))));
  if (!blocked) store.setSetting(workspaceId, POLLED_SETTING, JSON.stringify({ ...readJson<Record<string, string>>(store, workspaceId, POLLED_SETTING, {}), [need.id]: now.toISOString() }));
  return { kept, fresh, ...(blocked ? { blocked } : {}) };
}

/** Found pages read by the reader, a batch at a time; every item checked against its own page's text by code. */
async function readPages(store: CrosslineStore, workspaceId: string, need: StoredNeed, pages: Page[], deps: Clients, now: Date)
  : Promise<{ items: Array<{ item: ReadItem; via: NeedSource["kind"] }> } | { blocked: string }> {
  const client = deps.client();
  if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
  const out: Array<{ item: ReadItem; via: NeedSource["kind"] }> = [];
  for (let start = 0; start < pages.length; start += PAGES_PER_READING) {
    const batch = pages.slice(start, start + PAGES_PER_READING);
    const texts = new Map(batch.map((page) => [page.pageId, page.text]));
    const input = { version: "crossline.opportunity-reading.v1", today: now.toISOString().slice(0, 10), timeZone: zoneOf(store, workspaceId),
      need: { title: need.title, kind: need.kind, line: need.lineId, why: need.why }, pages: batch.map(({ pageId, url, text }) => ({ pageId, url, text })) };
    const result = await runCodexSkill<ReadingAnswer>(client, input, {
      skillName: OPPORTUNITY_READER, cwd: deps.cwd, developerInstructions: READER_INSTRUCTIONS, outputSchema: OPPORTUNITY_READING_SCHEMA, prepareInput: () => input,
      validateOutput: (output) => validateOpportunityReading(output, texts), softAccept: (_rejection, output) => output as ReadingAnswer,
      onAudit: () => {}, timeoutMs: 60 * 60_000
    });
    if (!result.ok) return { blocked: result.blocker.code };
    for (const raw of result.output.items) {
      const page = batch.find((item) => item.pageId === raw.pageId);
      if (!page) continue;
      // A mail with no link of its sender's site: the address the mail itself names (the reader copied it from the text).
      const url = page.url || (page.text.includes(raw.url) ? raw.url : "");
      if (!/^https:\/\//.test(url)) continue;
      const checked = checkReadItem({ ...raw, url, registrationUrl: raw.registrationUrl || url }, page.text);
      if (checked.problems.includes("eligibility_unquoted")) continue;
      out.push({ item: checked.item, via: page.via });
    }
  }
  return { items: out };
}

/** A `web` source: the reader searches the open web; each page it names is opened here and its quotes checked against what it says. */
async function searchWeb(store: CrosslineStore, workspaceId: string, need: StoredNeed, query: string, deps: Clients, now: Date, http: SafeGetDeps)
  : Promise<{ items: Array<{ item: ReadItem }> } | { blocked: string }> {
  const client = deps.client();
  if (!client) return { blocked: "CODEX_SUPERVISOR_UNAVAILABLE" };
  const web = (deps.webBlocker ?? webResearchBlocker)();
  if (web) return { blocked: web.code };
  const input = { version: "crossline.opportunity-reading.v1", today: now.toISOString().slice(0, 10), timeZone: zoneOf(store, workspaceId),
    need: { title: need.title, kind: need.kind, line: need.lineId, why: need.why }, search: { query }, pages: [] as Page[] };
  const result = await runCodexSkill<ReadingAnswer>(client, input, {
    skillName: OPPORTUNITY_READER, cwd: deps.cwd, developerInstructions: SEARCH_INSTRUCTIONS, outputSchema: OPPORTUNITY_READING_SCHEMA, prepareInput: () => input,
    allowWebSearch: true, validateOutput: (output) => output as ReadingAnswer, onAudit: () => {}, timeoutMs: 60 * 60_000
  });
  if (!result.ok) return { blocked: result.blocker.code };
  const items: Array<{ item: ReadItem }> = [];
  for (const raw of result.output.items.slice(0, 5)) {
    const html = await getText(raw.url, http);
    if (!html) continue;
    const text = htmlToText(html).slice(0, 60_000);
    if (!claimedTitleMatches(raw.title, text) && !text.toLowerCase().includes(raw.organizer.toLowerCase())) continue;
    const checked = checkReadItem({ ...raw, registrationUrl: raw.registrationUrl || raw.url }, text);
    if (checked.problems.includes("eligibility_unquoted")) continue;
    items.push({ item: checked.item });
  }
  return { items };
}

/** Housekeeping after answers: verdicts judged again from the latest facts (an answered question settles every opportunity it bears on). */
export const rejudge = (store: CrosslineStore, workspaceId: string, now = new Date()) => rejudgeOpportunities(store, workspaceId, now);

/** A mail the triage marked as an opportunity, kept for the next poll of a tracked need of its line (the line the triage gave). */
export function addMailCandidate(store: CrosslineStore, workspaceId: string, candidate: MailCandidate): void {
  const list = readJson<MailCandidate[]>(store, workspaceId, MAIL_CANDIDATES_SETTING, []);
  if (list.some((item) => item.key === candidate.key)) return;
  store.setSetting(workspaceId, MAIL_CANDIDATES_SETTING, JSON.stringify([...list, candidate].slice(-40)));
}

/** Whether the opportunity agent runs for this workspace: the machine owner's (the installed copy's one account included), never a hosted guest. */
export function opportunityAgentOn(store: CrosslineStore, workspaceId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CROSSLINE_PUBLIC_BETA !== "1" && runtimeOwner(store, env) === workspaceId;
}

/**
 * Which line an opportunity mail belongs to: a tracked need whose `mail` source names its sender or words, else a tracked need whose
 * title shares a word with the subject; "" when none does (the next need polled reads it under its own line).
 */
export function mailCandidateLine(store: CrosslineStore, workspaceId: string, message: { fromAddress: string; subject: string; snippet: string }): string {
  const tracked = scoutNeeds(store, workspaceId).filter((need) => need.state === "tracking");
  const text = `${message.subject} ${message.snippet}`.toLowerCase();
  const bySource = tracked.find((need) => need.sources.some((source) => source.kind === "mail"
    && ((source.from && message.fromAddress.toLowerCase().includes(source.from.toLowerCase())) || source.query.toLowerCase().split(/\s+/).filter((word) => word.length > 2).every((word) => text.includes(word)))));
  if (bySource) return bySource.lineId;
  const byTitle = tracked.find((need) => need.title.toLowerCase().split(/[\s,，、]+/).filter((word) => word.length > 1).some((word) => text.includes(word)));
  return byTitle?.lineId ?? "";
}
