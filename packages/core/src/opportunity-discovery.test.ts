import { describe, expect, it } from "vitest";
import {
  OPPORTUNITY_READING_SCHEMA, aiDeadlines, applicantFrom, ccfddlDeadlines, checkReadItem, degreeStageOf, devpostHackathons,
  eligibilityAnswer, judgeEligibility, mergeNeeds, needFromProposal, nextMonthDay, opportunityFromRead, opportunityKey,
  parsePostings, prepStartFor, termSlot, validateOpportunityReading,
  type EligibilityTerm, type ProposedNeed, type ReadItem, type StoredNeed
} from "./opportunity-discovery";
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
    const opportunity = opportunityFromRead(item(), { lineId: "research", needId: "need:research:x", foundVia: "web", foundAt: "2026-11-01T00:00:00Z", idOf: (key) => `opp-${key.length}` });
    expect(opportunity).toMatchObject({ registrationHost: "jobs.example.org", cost: { amount: 0 }, eligibility: [{ dim: "degree_stage", quote: "Open to current graduate students" }] });
  });
});

describe("eligibility, judged by code", () => {
  it("reads only confirmed facts, the person's own apply.* answer first", () => {
    const applicant = applicantFrom([fact("degree", "本科"), fact("apply.degree_stage", "硕士在读"), fact("school", "UW", "inferred"), fact("major", "假设：EE")]);
    expect(applicant.degree_stage).toMatchObject({ value: "硕士在读", slot: "apply.degree_stage" });
    expect(applicant.school).toBeUndefined();
    expect(applicant.field).toBeUndefined();
  });

  it("does not read another line's slot of the same name as the person's", () => {
    const facts = [{ identityId: "investment", projectId: "stocks", slot: "stage", value: "已有约 1 万美元的个人账户", status: "confirmed" as const },
      { identityId: "research", projectId: "ece555", slot: "meeting_location", value: "Plant Sci 108", status: "confirmed" as const },
      { identityId: "research", projectId: "", slot: "stage", value: "博士阶段刚开始", status: "confirmed" as const }];
    const applicant = applicantFrom(facts);
    expect(applicant.degree_stage).toMatchObject({ value: "博士阶段刚开始", factId: "research//stage" });
    expect(applicant.region).toBeUndefined();
  });

  it("is eligible, ineligible or a question, never a refusal for a spelling", () => {
    const masters = applicantFrom([fact("apply.degree_stage", "硕士")]);
    expect(judgeEligibility([term()], masters).state).toBe("eligible");
    const undergrad = applicantFrom([fact("apply.degree_stage", "大三")]);
    expect(judgeEligibility([term()], undergrad)).toMatchObject({ state: "ineligible", failed: [{ dim: "degree_stage" }] });
    expect(judgeEligibility([term()], applicantFrom([])).state).toBe("unknown");
    const country = term({ dim: "citizenship", rule: "美国公民", accepts: { kind: "one_of", values: ["United States"], min: -1, max: -1 } });
    expect(judgeEligibility([country], applicantFrom([fact("apply.citizenship", "中国")])).state).toBe("unknown");
    const age = term({ dim: "age", rule: "18–25 岁", accepts: { kind: "range", values: [], min: 18, max: 25 } });
    expect(judgeEligibility([age], applicantFrom([fact("apply.age", "30")])).state).toBe("ineligible");
    expect(judgeEligibility([age], applicantFrom([fact("apply.age", "24")])).state).toBe("eligible");
  });

  it("settles a free-text term by the person's own yes or no", () => {
    const portfolio = term({ dim: "other", rule: "有可展示的作品", accepts: { kind: "text", values: [], min: -1, max: -1 } });
    expect(judgeEligibility([portfolio], applicantFrom([])).state).toBe("unknown");
    const answer = eligibilityAnswer(portfolio, "是的，有");
    expect(answer).toEqual({ slot: termSlot("有可展示的作品"), value: "yes" });
    expect(judgeEligibility([portfolio], applicantFrom([fact(answer!.slot, answer!.value)])).state).toBe("eligible");
    expect(judgeEligibility([portfolio], applicantFrom([fact(answer!.slot, "no")])).state).toBe("ineligible");
    expect(eligibilityAnswer(term(), "博士二年级")).toEqual({ slot: "apply.degree_stage", value: "博士二年级" });
  });

  it("reads degree stages in either language", () => {
    expect(degreeStageOf("PhD candidate")).toBe("phd");
    expect(degreeStageOf("研二")).toBe("masters");
    expect(degreeStageOf("postdoc")).toBe("postdoc");
    expect(degreeStageOf("大四")).toBe("undergraduate");
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
