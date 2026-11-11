import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { emptyStats, pushable, type StoredWatch } from "@crossline/core";
import { CrosslineStore, saveWatchList, surfacedOpportunities } from "@crossline/db";
import { MAIL_CANDIDATES_SETTING, OPPORTUNITY_READER, addMailCandidate, mailCandidateLine, runWatch } from "./opportunities";
import { fakeRuntime } from "./testing/fake-runtime";

/**
 * Tags, lines and low-value social gatherings (docs/opportunity-agent.md §18, 2026-11-10), driven through the real watch run with the
 * recorded-shape fixture `opportunity-mail-social-and-lines.json`: mail candidates no longer get a line from subject words, the reader's
 * claims are judged by code, and dances, coffee hours and mixers never reach the person unless a line's goal is meeting people.
 */

type Case = { expect: { pushed: boolean; lowValue?: string; type: string; first?: string; lines?: string[] }; mail: { key: string; subject: string; from: string; text: string; url: string };
  answer: Record<string, unknown> };
const FIXTURE = JSON.parse(readFileSync(path.join(import.meta.dirname, "testing/fixtures/opportunity-mail-social-and-lines.json"), "utf8")) as {
  lines: unknown[]; milestones: Array<{ id: string; lineId: string; title: string }>; cases: Case[] };

let store: CrosslineStore;
let ws: string;
const NOW = new Date("2026-11-10T15:00:00.000Z");
beforeEach(() => {
  store = new CrosslineStore(":memory:");
  ws = store.createPrincipalWithWorkspace("u", "w").workspace.id;
  store.setSetting(ws, "lines.v1", JSON.stringify(FIXTURE.lines));
  for (const milestone of FIXTURE.milestones) store.saveMilestone({ id: milestone.id, ownerId: "o", workspaceId: ws, identityId: milestone.lineId, projectId: "",
    title: milestone.title, version: 1, status: "approved" });
});
afterEach(() => store.close());

const watch = (over: Partial<StoredWatch> = {}): StoredWatch => ({
  id: "need:research:isca", lineId: "research", title: "类脑硬件会议与实习", why: "论文和实习", origin: "derived",
  basis: { factIds: [], milestoneIds: ["ms-paper"], opportunityIds: [] }, query: "neuromorphic hardware workshop internship", tools: ["mail_search"], targets: [],
  judge: "类脑方向", explore: false, everyDays: 1, horizonDays: 365, state: "active", stats: emptyStats(), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
  leadDays: 14, prescreen: [], weight: 1, strictness: 0, ...over
});
const http = { isPublicHost: async () => true, fetchImpl: (async () => new Response("not found", { status: 404 })) as unknown as typeof fetch };

test("a mail's line is no longer guessed from subject words: only a watch that names its sender claims it", () => {
  saveWatchList(store, ws, [watch({ title: "Winter school and ball season" }),
    watch({ id: "need:startup:angels", lineId: "startup", title: "投资人活动", targets: [{ tool: "mail_search", from: "madisonstartups.com", query: "" }] })]);
  // The old rule filed this under research because the watch's title shares 「ball」 with the subject.
  expect(mailCandidateLine(store, ws, { fromAddress: "ecegsa@engr.wisc.edu", subject: "ECE GSA Winter Ball 2026", snippet: "" })).toBe("");
  expect(mailCandidateLine(store, ws, { fromAddress: "hello@madisonstartups.com", subject: "Angels night", snippet: "" })).toBe("startup");
});

test("fixture: social gatherings are kept but never pushed, the founders' night is, and a find serves several lines", async () => {
  const research = watch();
  saveWatchList(store, ws, [research]);
  for (const item of FIXTURE.cases) addMailCandidate(store, ws, { ...item.mail, lineId: "", at: NOW.toISOString() });
  // One page per reader call: each turn is answered with the fixture answer for the mail its prompt carries.
  const answer = (prompts: string[]) => {
    const prompt = prompts.at(-1) ?? "";
    const item = FIXTURE.cases.find((entry) => prompt.includes(entry.mail.url));
    const pageId = /"pageId":\s*"(p\d+)"/.exec(prompt)?.[1] ?? "p1";
    return JSON.stringify({ items: item ? [{ ...item.answer, pageId }] : [], blocked: "" });
  };
  const runtime = fakeRuntime([answer], OPPORTUNITY_READER);
  const deps = { client: () => runtime.rpc, cwd: ".", http, now: () => NOW, costSince: () => 0 };
  await runWatch(store, ws, research, deps);
  await runWatch(store, ws, research, deps);
  expect(store.getSetting(ws, MAIL_CANDIDATES_SETTING)).toBe("[]");
  const rows = new Map(store.listOpportunities(ws).map((row) => [row.url, row]));
  const shown = new Set(surfacedOpportunities(store, ws, "2026-11-10").filter((row) => row.inbox).map((row) => row.url));
  for (const item of FIXTURE.cases) {
    const row = rows.get(item.mail.url);
    expect(row, item.mail.subject).toBeDefined();
    expect(row!.type, item.mail.subject).toBe(item.expect.type);
    expect(shown.has(item.mail.url), item.mail.subject).toBe(item.expect.pushed);
    if (item.expect.lowValue) expect(row!.lowValue, item.mail.subject).toBe(item.expect.lowValue);
    if (item.expect.first) expect(row!.lineId).toBe(item.expect.first);
    if (item.expect.lines) expect(row!.lines!.filter((tag) => tag.relevance >= 0.6).map((tag) => tag.lineId).sort()).toEqual(item.expect.lines);
  }
  // The research watch read every mail, but only what it actually serves counts as its find.
  const yoga = rows.get("https://recwell.wisc.edu/mindful-mondays")!;
  expect(pushable(yoga)).toBe(false);
  expect(yoga.lines?.some((tag) => tag.lineId === "research")).toBe(false);
  expect(store.listOpportunities(ws, { lineId: "startup" }).map((row) => row.title).sort()).toEqual(["Badger Hacks 2026", "Madison Founders & Angels Networking Night"]);
});
