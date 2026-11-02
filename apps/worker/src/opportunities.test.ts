import { afterEach, beforeEach, expect, test } from "vitest";
import { CCFDDL_URL, RUNTIME_OWNER_SETTING, SCOUT_NEEDS_SETTING, type StoredNeed } from "@crossline/core";
import { CrosslineStore } from "@crossline/db";
import { MAIL_CANDIDATES_SETTING, OPPORTUNITY_READER, needsDue, needsToPoll, opportunityAgentOn, pollNeed } from "./opportunities";
import { fakeRuntime } from "./testing/fake-runtime";

let store: CrosslineStore;
let ws: string;
const NOW = new Date("2026-11-01T12:00:00.000Z");
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("u", "w").workspace.id;
});
afterEach(() => store.close());

const need = (over: Partial<StoredNeed> = {}): StoredNeed => ({
  id: "need:research:venue", lineId: "research", kind: "stream", title: "顶会投稿", why: "研究线的论文需要投稿去处", factIds: [], milestoneIds: [],
  leadDays: 30, eligibility: [], sources: [], state: "tracking", ...over
});

const routes = (map: Record<string, { body: string; type: string }>) => ({
  isPublicHost: async () => true,
  fetchImpl: (async (input: string | URL | Request) => {
    const url = String(input);
    const hit = Object.entries(map).find(([prefix]) => url.startsWith(prefix));
    return hit ? new Response(hit[1].body, { status: 200, headers: { "content-type": hit[1].type } }) : new Response("not found", { status: 404 });
  }) as typeof fetch
});

test("only the machine owner's workspace runs the agent, and never on the hosted beta", () => {
  const guest = store.createPrincipalWithWorkspace("g", "g").workspace.id;
  store.setSetting(ws, RUNTIME_OWNER_SETTING, "1");
  expect(opportunityAgentOn(store, ws, {})).toBe(true);
  expect(opportunityAgentOn(store, guest, {})).toBe(false);
  expect(opportunityAgentOn(store, ws, { CROSSLINE_PUBLIC_BETA: "1" })).toBe(false);
});

test("needs are not worked out before the account is set up", () => {
  expect(needsDue(store, ws, NOW)).toEqual([]);
});

test("a conference list is read without a model, past deadlines left out, and a re-read adds nothing new", async () => {
  const yaml = `- title: NeurIPS
  description: Neural Information Processing Systems
  dblp: nips
  confs:
    - year: 2027
      link: https://neurips.cc
      timezone: AoE
      place: Sydney
      timeline:
        - deadline: '2027-05-15 23:59:59'
        - deadline: '2026-05-15 23:59:59'
`;
  store.setSetting(ws, SCOUT_NEEDS_SETTING, JSON.stringify([need({ sources: [{ kind: "deadline_list", list: "ccfddl", query: "NeurIPS" }] })]));
  const deps = { client: () => undefined, cwd: ".", http: routes({ [CCFDDL_URL]: { body: yaml, type: "text/yaml" } }), now: () => NOW };
  const first = await pollNeed(store, ws, need({ sources: [{ kind: "deadline_list", list: "ccfddl", query: "NeurIPS" }] }), deps);
  expect(first).toEqual({ kept: 1, fresh: 1 });
  expect(store.listOpportunities(ws)[0]).toMatchObject({ title: "NeurIPS 2027", verdict: { state: "eligible" }, deadlines: [{ day: "2027-05-15" }] });
  expect(needsToPoll(store, ws, NOW)).toEqual([]);
  const again = await pollNeed(store, ws, need({ sources: [{ kind: "deadline_list", list: "ccfddl", query: "NeurIPS" }] }), deps);
  expect(again).toEqual({ kept: 1, fresh: 0 });
});

test("a job board's internship goes to the reader, and an invented term never reaches the ledger", async () => {
  const board = JSON.stringify({ jobs: [{ id: 7, title: "Research Intern, Summer 2027", absolute_url: "https://boards.greenhouse.io/lab/jobs/7",
    content: "&lt;p&gt;Applications close on December 1, 2026. Open to current graduate students.&lt;/p&gt;", location: { name: "Seattle" } }] });
  const read = (quote: string) => JSON.stringify({ items: [{ pageId: "p1", url: "https://boards.greenhouse.io/lab/jobs/7", title: "Research Intern, Summer 2027",
    organizer: "Lab", kind: "application", deadlines: [{ day: "2026-12-01", quote: "Applications close on December 1, 2026" }], startsAt: { day: "", quote: "" },
    cost: { known: false, amount: 0, currency: "", quote: "" }, location: "Seattle",
    eligibility: [{ dim: "degree_stage", rule: "在读研究生", quote, accepts: { kind: "one_of", values: ["graduate"], min: -1, max: -1 } }],
    needsAccount: true, materials: ["CV"], consents: [], registrationUrl: "" }], blocked: "" });
  const source = { kind: "ats" as const, provider: "greenhouse" as const, board: "lab", query: "" };
  store.upsertProfileFact({ workspaceId: ws, identityId: "person", projectId: "", slot: "apply.degree_stage", value: "PhD", status: "confirmed",
    sourceRef: "reply-1", sourceQuote: "PhD", updatedAt: NOW.toISOString() });
  const http = routes({ "https://boards-api.greenhouse.io/": { body: board, type: "application/json" } });

  // The first answer misquotes a term, the repair copies it from the page.
  const runtime = fakeRuntime([read("Only PhD students"), read("Open to current graduate students")], OPPORTUNITY_READER);
  const result = await pollNeed(store, ws, need({ sources: [source] }), { client: () => runtime.rpc, cwd: ".", http, now: () => NOW });
  expect(result).toEqual({ kept: 1, fresh: 1 });
  expect(runtime.turns()).toBe(2);
  const [row] = store.listOpportunities(ws);
  expect(row).toMatchObject({ foundVia: "ats", registrationHost: "boards.greenhouse.io", verdict: { state: "eligible" } });

  // A reader that never copies the term: the opening is dropped rather than kept with no condition.
  store.close();
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("u", "w").workspace.id;
  const stubborn = fakeRuntime([read("Only PhD students")], OPPORTUNITY_READER);
  const dropped = await pollNeed(store, ws, need({ sources: [source] }), { client: () => stubborn.rpc, cwd: ".", http, now: () => NOW });
  expect(dropped.kept).toBe(0);
  expect(store.listOpportunities(ws)).toEqual([]);
});

test("mail the triage marked as an opportunity is read like a page and then let go", async () => {
  store.setSetting(ws, MAIL_CANDIDATES_SETTING, JSON.stringify([{ key: "m1", lineId: "research", subject: "Call for Workshop Papers",
    from: "chair@example.org", text: "Submissions are due November 20, 2026.", url: "https://example.org/workshop", at: NOW.toISOString() }]));
  const answer = JSON.stringify({ items: [{ pageId: "p1", url: "https://example.org/workshop", title: "Workshop", organizer: "Example", kind: "application",
    deadlines: [{ day: "2026-11-20", quote: "Submissions are due November 20, 2026" }], startsAt: { day: "", quote: "" },
    cost: { known: false, amount: 0, currency: "", quote: "" }, location: "", eligibility: [], needsAccount: false, materials: [], consents: [], registrationUrl: "" }], blocked: "" });
  const runtime = fakeRuntime([answer], OPPORTUNITY_READER);
  const result = await pollNeed(store, ws, need(), { client: () => runtime.rpc, cwd: ".", http: routes({}), now: () => NOW });
  expect(result.fresh).toBe(1);
  expect(store.listOpportunities(ws)[0]?.foundVia).toBe("mail");
  expect(store.getSetting(ws, MAIL_CANDIDATES_SETTING)).toBe("[]");
});
