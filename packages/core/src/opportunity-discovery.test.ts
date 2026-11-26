import { describe, expect, it } from "vitest";
import {
  OPPORTUNITY_READING_SCHEMA, aiDeadlines, ccfddlDeadlines, checkReadItem, devpostHackathons, eligibilityAnswer, fitOf, mergeNeeds, needFromProposal,
  nextMonthDay, offerOrder, offerPushable, opportunityFromListed, opportunityFromRead, opportunityKey, placeFromLocation, carriesPersonData, parsePostings,
  phishingSigns, prepStartFor, quoteYearAgrees, readItemUnusable, readerPerson, stageConflict, termSlot, validateOpportunityReading, verdictFromFit,
  type EligibilityTerm, type ProposedNeed, type ReadItem, type StoredNeed
} from "./opportunity-discovery";
import type { OpportunityFit } from "./opportunity";
import { structuredOutputProblems } from "./structured-output";

const proposal = (over: Partial<ProposedNeed> = {}): ProposedNeed => ({
  key: "summer-intern", kind: "cycle", title: "暑期研究实习", why: "研究线需要一段工业界研究经历", factIds: ["research//goal"], milestoneIds: [],
  window: { opensMonth: 9, closesMonth: 11, basis: "往年 9 月开放、11 月截止", sourceUrl: "https://example.org/careers" }, leadDays: 30,
  eligibility: [], sources: [{ kind: "ats", provider: "greenhouse", board: "example", query: "intern" }], ...over
});

const term = (over: Partial<EligibilityTerm> = {}): EligibilityTerm => ({
  dim: "degree_stage", rule: "在读研究生", quote: "Open to current graduate students", accepts: { kind: "one_of", values: ["graduate"], min: -1, max: -1 }, ...over
});
const detailOf = (run: () => unknown) => { try { run(); return ""; } catch (error) { return (error as { detail?: string }).detail ?? ""; } };
const fact = (slot: string, value: string, status: "confirmed" | "inferred" = "confirmed") => ({ identityId: "person", projectId: "", slot, value, status });

describe("schemas", () => {
  it("meet the strict structured-output rules", () => {
    expect(structuredOutputProblems(OPPORTUNITY_READING_SCHEMA)).toEqual([]);
  });
});

describe("needs", () => {
  it("moves a cycle's window to its next occurrence and works back the start of preparation", () => {
    expect(nextMonthDay("2026-11-01", 9)).toBe("2027-09-01");
    expect(nextMonthDay("2026-11-01", 11, 30)).toBe("2026-11-30");
    const need = needFromProposal("research", proposal(), "2026-12-15");
    expect(need.window).toMatchObject({ opens: "2027-09", closes: "2027-11" });
    expect(need.prepStartsOn).toBe("2027-10-31");
    // Inside a September–November round on 1 November: this round, preparation already due.
    const open = needFromProposal("research", proposal(), "2026-11-01");
    expect(open.window).toMatchObject({ opens: "2026-09", closes: "2026-11" });
    expect(open.prepStartsOn).toBe("2026-11-01");
    // A round that wraps the year end (November–February) seen in January.
    const wrap = needFromProposal("research", proposal({ window: { opensMonth: 11, closesMonth: 2, basis: "", sourceUrl: "https://example.org" } }), "2027-01-10");
    expect(wrap.window).toMatchObject({ opens: "2026-11", closes: "2027-02" });
    expect(need.state).toBe("proposed");
    expect(need.id).toBe("need:research:summer-intern");
  });

  it("keeps the person's decisions across a new derivation", () => {
    const fresh = (key: string, title = key): StoredNeed => ({ ...needFromProposal("research", proposal({ key, title }), "2026-11-01") });
    const kept: StoredNeed[] = [
      { ...fresh("tracked", "old"), state: "tracking", decidedAt: "2026-10-01" },
      { ...fresh("declined"), state: "declined" },
      fresh("stale"),
      { ...needFromProposal("media", proposal({ key: "other" }), "2026-11-01") }
    ];
    const merged = mergeNeeds(kept, "research", [fresh("tracked", "new"), fresh("declined"), fresh("added")]);
    const byId = new Map(merged.map((need) => [need.id, need]));
    expect(byId.get("need:research:tracked")).toMatchObject({ state: "tracking", title: "new", decidedAt: "2026-10-01" });
    expect(byId.get("need:research:declined")?.state).toBe("declined");
    expect(byId.has("need:research:stale")).toBe(false);
    expect(byId.get("need:research:added")?.state).toBe("proposed");
    expect(byId.has("need:media:other")).toBe(true);
  });
});

const page = "Summer Research Internship 2027. Applications close on December 1, 2026. Open to current graduate students. Application fee: $0.";
const item = (over: Partial<ReadItem> = {}): ReadItem => ({
  pageId: "p1", url: "https://jobs.example.org/intern", title: "Summer Research Internship 2027", organizer: "Example Lab", kind: "application",
  deadlines: [{ day: "2026-12-01", quote: "Applications close on December 1, 2026" }], startsAt: { day: "", quote: "" },
  cost: { known: true, amount: 0, currency: "USD", quote: "Application fee: $0" }, location: "", eligibility: [term()], needsAccount: true,
  materials: ["CV"], consents: [], registrationUrl: "", ...over
});

describe("reading a page", () => {
  it("accepts quotes copied with other punctuation and refuses invented ones", () => {
    expect(checkReadItem(item(), page).problems).toEqual([]);
    const loose = checkReadItem(item({ deadlines: [{ day: "2026-12-01", quote: "applications CLOSE on December 1 2026" }] }), page);
    expect(loose.problems).toEqual([]);
    const wrongDay = checkReadItem(item({ deadlines: [{ day: "2026-12-02", quote: "Applications close on December 1, 2026" }] }), page);
    expect(wrongDay.problems).toContain("deadline_unquoted");
    expect(wrongDay.item.deadlines).toEqual([]);
    const invented = checkReadItem(item({ eligibility: [term({ quote: "Only PhD students may apply" })] }), page);
    expect(invented.problems).toContain("eligibility_unquoted");
    const fee = checkReadItem(item({ cost: { known: true, amount: 50, currency: "USD", quote: "Fee: $50" } }), page);
    expect(fee.item.cost.known).toBe(false);
  });

  it("keeps an earlier cycle's date out and takes a moved deadline's current day (D4, D7)", () => {
    const lastYear = "The 2025 cohort closed on December 1, 2025. Dates for 2026 will be announced.";
    const old = checkReadItem(item({ deadlines: [{ day: "2026-12-01", quote: "The 2025 cohort closed on December 1, 2025" }] }), lastYear);
    expect(old.item.deadlines).toEqual([]);
    expect(quoteYearAgrees("2026-12-01", "December 1")).toBe(true);
    const extended = "The application deadline has been extended: originally October 30, 2026, now November 14, 2026.";
    const moved = checkReadItem(item({ deadlines: [{ day: "2026-10-30", quote: "originally October 30, 2026" }] }), extended);
    expect(moved.item.deadlines.map((deadline) => deadline.day)).toEqual(["2026-11-14"]);
  });

  it("sends a misquote back to the reader, naming the opening", () => {
    const pages = new Map([["p1", page]]);
    expect(validateOpportunityReading({ items: [item()], blocked: "" }, pages).items).toHaveLength(1);
    expect(detailOf(() => validateOpportunityReading({ items: [item({ eligibility: [term({ quote: "made up" })] })], blocked: "" }, pages))).toMatch(/Summer Research/);
    expect(detailOf(() => validateOpportunityReading({ items: [item({ pageId: "p9" })], blocked: "" }, pages))).toMatch(/p9/);
  });

  it("gives one key per opening whatever the year in its title or the order of its deadlines", () => {
    const a = opportunityKey("https://jobs.example.org/a", "Summer Internship 2027", [{ day: "2026-12-01", quote: "" }, { day: "2026-11-01", quote: "" }]);
    const b = opportunityKey("https://JOBS.example.org/b", "summer internship", [{ day: "2026-11-01", quote: "" }]);
    expect(a).toBe(b);
    // One event announced as 「'26」 on Devpost and 「2026」 in a mail is one key (D3).
    expect(opportunityKey("https://hack.devpost.com/", "Lakeshore Hack '26", [])).toBe(opportunityKey("https://hack.devpost.com/?utm_source=x", "Lakeshore Hack 2026", []));
    const opportunity = opportunityFromRead(item(), { lineId: "research", needId: "need:research:x", foundVia: "web", foundAt: "2026-11-01T00:00:00Z", idOf: (key) => `opp-${key.length}` });
    expect(opportunity).toMatchObject({ registrationHost: "jobs.example.org", cost: { amount: 0 }, eligibility: [{ dim: "degree_stage", quote: "Open to current graduate students" }] });
  });
});

describe("where an opening is held (D11)", () => {
  const venue = "Pacific Systems Student Conference 2026. November 28–29, 2026, Vancouver, BC, Canada. In person only. Register by November 20, 2026.";
  const meta = { lineId: "research", foundVia: "web" as const, foundAt: "2026-11-01T00:00:00Z", idOf: (key: string) => `opp-${key.length}` };
  const at = (over: Partial<ReadItem>) => item({ eligibility: [], cost: { known: false, amount: 0, currency: "", quote: "" },
    deadlines: [{ day: "2026-11-20", quote: "Register by November 20, 2026." }], ...over });
  const read = (over: Partial<ReadItem>) => opportunityFromRead(checkReadItem(at(over), venue).item, meta);

  it("keeps the reader's place as far as the page says it", () => {
    const quote = "November 28–29, 2026, Vancouver, BC, Canada. In person only.";
    expect(read({ place: { mode: "in_person", city: "Vancouver", country: "Canada", quote } }).place).toEqual({ mode: "in_person", city: "Vancouver", country: "Canada", quote });
    // A country the quote does not name is left to the geocoder, never written in.
    expect(read({ place: { mode: "in_person", city: "Vancouver", country: "加拿大", quote } }).place).toEqual({ mode: "in_person", city: "Vancouver", quote });
    // A quote not on the page is no place, and is sent back to the reader.
    const invented = checkReadItem(at({ place: { mode: "in_person", city: "Seattle", country: "", quote: "Held in Seattle, WA." } }), venue);
    expect(invented.problems).toContain("place_unquoted");
    expect(invented.item.place).toMatchObject({ mode: "unknown" });
    expect(readItemUnusable(invented.problems)).toBe(false);
    expect(detailOf(() => validateOpportunityReading({ items: [at({ place: { mode: "in_person", city: "Seattle", country: "", quote: "Held in Seattle, WA." } })], blocked: "" },
      new Map([["p1", venue]])))).toMatch(/place\.quote/);
  });

  it("derives a place from a location line on the page when the reader gave none, and guesses none otherwise", () => {
    expect(read({ location: "Vancouver, BC, Canada" }).place).toEqual({ mode: "in_person", city: "Vancouver, BC, Canada", quote: "Vancouver, BC, Canada" });
    expect(read({ location: "Vancouver, BC, Canada", place: { mode: "unknown", city: "", country: "", quote: "" } }).place).toMatchObject({ city: "Vancouver, BC, Canada" });
    // A location the page does not name is not where it is held.
    const elsewhere = read({ location: "Chicago, IL" });
    expect(elsewhere.place).toBeUndefined();
    expect(elsewhere.location).toBeUndefined();
    expect(read({ location: "" }).place).toBeUndefined();
  });

  it("reads a location line's mode and city", () => {
    expect(placeFromLocation("Engineering Hall 1800, Madison, WI")).toEqual({ mode: "in_person", city: "Madison, WI", quote: "Engineering Hall 1800, Madison, WI" });
    expect(placeFromLocation("Online")).toEqual({ mode: "online", quote: "Online" });
    expect(placeFromLocation("Boston, MA (hybrid)")).toEqual({ mode: "hybrid", city: "Boston, MA", quote: "Boston, MA (hybrid)" });
    expect(placeFromLocation("  ")).toBeUndefined();
    expect(placeFromLocation("Room 1800")).toBeUndefined();
  });

  it("gives a listed conference its place", () => {
    const listed = opportunityFromListed({ title: "SYNTHSYS 2027", url: "https://synthsys.example/2027", deadline: { day: "2026-12-01", quote: "deadline: '2026-12-01'" },
      place: "Vancouver, Canada", note: "" }, meta);
    expect(listed.place).toEqual({ mode: "in_person", city: "Vancouver, Canada", quote: "Vancouver, Canada" });
  });
});

const fit = (over: Partial<OpportunityFit> = {}): OpportunityFit => ({ stageFit: "fits", directionFit: "same", reachable: true, partialRequirements: [],
  agentCanPrepare: [], why: "博士生的研究实习，方向一致", ...over });

describe("eligibility, judged by the reader's fit (2026-11-25)", () => {
  it("keeps away only the wrong stage, an unrelated direction or a bar the person cannot clear", () => {
    expect(verdictFromFit(fit())).toMatchObject({ state: "eligible", fit: { stageFit: "fits" } });
    // A partial match, a stretch and an adjacent direction all reach the person, with what is missing kept for the card.
    const partial = verdictFromFit(fit({ stageFit: "stretch", directionFit: "adjacent", partialRequirements: ["无顶会论文"], agentCanPrepare: ["求职信草稿"] }));
    expect(partial).toMatchObject({ state: "eligible", fit: { partialRequirements: ["无顶会论文"], agentCanPrepare: ["求职信草稿"] } });
    expect(verdictFromFit(fit({ stageFit: "wrong_stage", why: "正职，本人在找实习" }))).toMatchObject({ state: "ineligible", failed: [{ dim: "degree_stage", why: "正职，本人在找实习" }] });
    expect(verdictFromFit(fit({ directionFit: "unrelated" }))).toMatchObject({ state: "ineligible", failed: [{ dim: "field" }] });
    // A bar the person cannot clear is shown, marked 「不满足」 on the card, after the reachable ones (the owner, 2026-11-26).
    expect(verdictFromFit(fit({ reachable: false }))).toMatchObject({ state: "eligible", fit: { reachable: false } });
    // No fit (a listed call for papers, a reading from before): eligible, never a question.
    expect(verdictFromFit(undefined)).toEqual({ state: "eligible", basis: [] });
  });

  it("reads a fit only in the schema's shape; anything else is no fit", () => {
    expect(fitOf({ stageFit: "fits", directionFit: "same" })).toEqual({ stageFit: "fits", directionFit: "same", reachable: true, partialRequirements: [], agentCanPrepare: [], why: "" });
    expect(fitOf({ stageFit: "maybe", directionFit: "same" })).toBeUndefined();
    expect(fitOf(undefined)).toBeUndefined();
    expect(fitOf({ ...fit(), partialRequirements: ["a", "", "b", "c", "d", "e", "f"] })?.partialRequirements).toEqual(["a", "b", "c", "d", "e"]);
  });

  it("hands the reader the person's confirmed facts without identifiers, and what every active watch seeks", () => {
    const person = readerPerson([fact("apply.degree_stage", "PhD student (second year)"), fact("apply.full_name", "Qiao Lin"), fact("apply.email", "q@x.example"),
      fact("apply.major", "假设：EE"), fact("apply.school", "UW", "inferred"), { ...fact("stage", "博士"), identityId: "research" }, fact(termSlot("有作品"), "yes")],
    [{ title: "暑期研究实习", judge: "博士可申请", state: "active" }, { title: "旧的", judge: "", state: "retired" }]);
    expect(person).toEqual({ facts: [{ slot: "apply.degree_stage", value: "PhD student (second year)" }], seeking: ["暑期研究实习：博士可申请"] });
  });

  it("notes a full-time job while every watch seeks internships, without overruling the reader", () => {
    expect(stageConflict("job", fit(), ["暑期研究实习 intern 博士"])).toBe(true);
    expect(stageConflict("job", fit({ stageFit: "wrong_stage" }), ["暑期研究实习"])).toBe(false);
    expect(stageConflict("job", fit(), ["暑期研究实习", "全职工作 full-time"])).toBe(false);
    expect(stageConflict("internship", fit(), ["暑期研究实习"])).toBe(false);
    expect(verdictFromFit(fit()).state).toBe("eligible");
  });

  it("pushes an opening in an adjacent direction a line still holds, and orders by direction, then deadline", () => {
    const tag = (relevance: number) => [{ lineId: "research", confidence: relevance, relevance, reason: "", anchors: [] }];
    const row = (id: string, relevance: number, over: Partial<OpportunityFit> | null, deadline = "2026-12-01") => ({ id, lineId: "research", type: "program" as const,
      lines: tag(relevance), deadlines: [{ day: deadline, quote: "" }], verdict: over ? verdictFromFit(fit(over)) : verdictFromFit(undefined) });
    expect(offerPushable(row("a", 0.4, { directionFit: "adjacent" }))).toBe(true);
    expect(offerPushable(row("b", 0.4, null))).toBe(false);
    expect(offerPushable(row("c", 0.2, { directionFit: "adjacent" }))).toBe(false);
    expect(offerPushable({ ...row("d", 0.4, { directionFit: "same" }), type: "paper" as const })).toBe(false);
    const sorted = [row("late-same", 0.7, {}, "2027-01-10"), row("adjacent", 0.9, { directionFit: "adjacent" }, "2026-11-30"), row("soon-same", 0.6, {}, "2026-12-01")]
      .sort(offerOrder("2026-11-25")).map((item) => item.id);
    expect(sorted).toEqual(["soon-same", "late-same", "adjacent"]);
    // One the person cannot clear comes after every one they can, however close its deadline.
    const withBar = [row("barred", 0.9, { reachable: false }, "2026-11-28"), row("adjacent", 0.9, { directionFit: "adjacent" }, "2026-12-20")]
      .sort(offerOrder("2026-11-25")).map((item) => item.id);
    expect(withBar).toEqual(["adjacent", "barred"]);
  });

  it("still reads an answer to a question on a card from before", () => {
    const portfolio = term({ dim: "other", rule: "有可展示的作品", accepts: { kind: "text", values: [], min: -1, max: -1 } });
    expect(eligibilityAnswer(portfolio, "是的，有")).toEqual({ slot: termSlot("有可展示的作品"), value: "yes" });
    expect(eligibilityAnswer(portfolio, "不满足")).toEqual({ slot: termSlot("有可展示的作品"), value: "no" });
    expect(eligibilityAnswer(term(), "博士二年级")).toEqual({ slot: "apply.degree_stage", value: "博士二年级" });
  });
});

describe("sources read without a model", () => {
  it("keeps internships, not 「internal」 or 「international」", () => {
    const body = { jobs: [
      { id: 1, title: "Research Intern, Summer 2027", absolute_url: "https://boards.greenhouse.io/x/jobs/1", content: "&lt;p&gt;Graduate students&lt;/p&gt;", location: { name: "Remote" } },
      { id: 2, title: "Internal Tools Engineer", absolute_url: "https://boards.greenhouse.io/x/jobs/2", content: "" },
      { id: 3, title: "International Sales", absolute_url: "https://boards.greenhouse.io/x/jobs/3", content: "" }
    ] };
    const postings = parsePostings("greenhouse", body, "");
    expect(postings.map((posting) => posting.id)).toEqual(["1"]);
    expect(postings[0]!.text).toBe("Graduate students");
    const lever = parsePostings("lever", [{ id: "a", text: "Software Engineer", hostedUrl: "https://jobs.lever.co/x/a", categories: { commitment: "Internship" } }], "");
    expect(lever).toHaveLength(1);
  });

  it("reads conference deadlines from today on, the YAML line as the quote", () => {
    const conf = [{ title: "NeurIPS", description: "Neural Information Processing Systems", dblp: "nips", confs: [
      { year: 2027, link: "http://neurips.cc", place: "Sydney", timezone: "AoE", timeline: [{ deadline: "2027-05-15 23:59:59", comment: "full paper" }, { deadline: "2026-01-01 00:00:00" }] }
    ] }];
    const listed = ccfddlDeadlines(conf, "neurips", "2026-11-01");
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ url: "https://neurips.cc", deadline: { day: "2027-05-15", quote: "deadline: '2027-05-15 23:59:59'" } });
    const hf = aiDeadlines([{ title: "ICML", year: 2027, link: "https://icml.cc", start: "2027-07-10", deadlines: [{ type: "abstract", date: "2027-01-20 23:59:59" }, { type: "paper", date: "2027-01-27 23:59:59" }] }], "2026-11-01");
    expect(hf[0]).toMatchObject({ deadline: { day: "2027-01-27" }, startsAt: { day: "2027-07-10" } });
  });

  it("lists open and upcoming hackathons only", () => {
    const body = { hackathons: [
      { title: "Build AI", url: "https://buildai.devpost.com", open_state: "open", submission_period_dates: "Nov 1 - 30, 2026", organization_name: "X" },
      { title: "Old", url: "https://old.devpost.com", open_state: "ended" }
    ] };
    expect(devpostHackathons(body).map((item) => item.title)).toEqual(["Build AI"]);
  });

  it("works back the start of preparation from a deadline", () => {
    expect(prepStartFor("2026-12-01", 30)).toBe("2026-11-01");
    expect(prepStartFor(undefined, 30)).toBeUndefined();
  });
});

describe("what is never read or requested", () => {
  it("screens phishing-shaped mail and keeps ordinary announcements (D5)", () => {
    expect(phishingSigns("You have been selected for the Global Research Award. To claim, reply with your passport number and phone number.")).toEqual(["asks_for_identifiers", "prize_claim"]);
    expect(phishingSigns("Lakeshore Hack '26 is now open! Submissions due November 22, 2026. Free to enter.")).toEqual([]);
    expect(phishingSigns("You have been selected for an interview. Please pick a time on the scheduling page.")).toEqual([]);
  });

  it("refuses an address carrying the person's name or email (D6)", () => {
    const ids = ["Qiao Lin", "qiao.lin@lakeshore.example"];
    expect(carriesPersonData("https://collect.evil.example/beacon?u=qiao", ids)).toBe(true);
    expect(carriesPersonData("https://x.example/?e=qiao.lin%40lakeshore.example", ids)).toBe(true);
    expect(carriesPersonData("https://quickhire.example/winter-intern", ids)).toBe(false);
    expect(carriesPersonData("https://lab.example/linear-algebra", ids)).toBe(false);
  });

  it("marks an opening of a past round and a quote from nowhere on the page as unusable (D4, D6)", () => {
    const lastYear = "The 2025 cohort closed applications on December 1, 2025.";
    expect(checkReadItem(item({ deadlines: [{ day: "2026-12-01", quote: lastYear }] }), lastYear).problems).toContain("earlier_cycle");
    expect(checkReadItem(item({ deadlines: [{ day: "2027-12-31", quote: "The deadline is December 31, 2027." }] }), page).problems).toContain("quote_absent");
    expect(readItemUnusable(checkReadItem(item(), page).problems)).toBe(false);
  });
});
