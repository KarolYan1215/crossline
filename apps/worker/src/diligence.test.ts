import { afterEach, beforeEach, expect, test } from "vitest";
import { CrosslineStore } from "@crossline/db";
import { DILIGENCE_SKILL, createDiligenceRunner, isPrivateAddress, linesDueForDiligence, pageSupports, verifySource } from "./diligence";
import { fakeRuntime as sharedRuntime } from "./testing/fake-runtime";

const fakeRuntime = (answers: string[]) => sharedRuntime(answers, DILIGENCE_SKILL);
let store: CrosslineStore;
let workspaceId: string;
const NOW = () => new Date("2026-10-02T12:00:00.000Z");
const cost = async () => ({ available: true as const, short: { usedPercent: 10 }, long: { usedPercent: 10 } }) as never;

beforeEach(() => {
  store = new CrosslineStore(":memory:");
  workspaceId = store.createPrincipalWithWorkspace("u", "w").workspace.id;
  for (const [slot, value] of [["stage", "只有自己在用"], ["constraint", "学生身份暂时无法全职创业"]] as const) {
    store.upsertProfileFact({ workspaceId, identityId: "startup", projectId: "crossline", slot, value, status: "confirmed", sourceRef: "reply-1", sourceQuote: value, updatedAt: "2026-10-02T00:00:00.000Z" });
  }
});
afterEach(() => store.close());

const page = (title: string, body = "") => new Response(`<html><head><title>${title}</title></head><body>${body}</body></html>`, { status: 200 });
const publicHost = async () => true;

const answer = (over: object = {}) => JSON.stringify({
  question: "找出适合学生身份的比赛和孵化器",
  sources: [
    { id: "s1", url: "https://example.edu/accelerator", title: "Student Accelerator Program", publisher: "Example University", accessedOn: "2026-10-02" },
    { id: "s2", url: "https://made-up.example.org/page", title: "Imaginary Contest Rules", publisher: "Nobody", accessedOn: "2026-10-02" }
  ],
  findings: [
    { id: "f1", claim: "该孵化器接受在读学生，申请截止 2026-11-15。", sourceIds: ["s1"], confidence: "high", staleWhen: "下一届开放时" },
    { id: "f2", claim: "某比赛要求至少 5 名团队成员。", sourceIds: ["s2"], confidence: "medium", staleWhen: "规则更新时" }
  ],
  proposals: [
    { id: "p1", title: "11/15 前提交学生孵化器申请", why: "符合在读学生身份", kind: "milestone", dueDate: "2026-11-15", basedOnFacts: ["startup/crossline/stage"], findingIds: ["f1"] },
    { id: "p2", title: "组一个 5 人团队参加比赛", why: "比赛要求团队规模", kind: "task", dueDate: "", basedOnFacts: [], findingIds: ["f2"] }
  ],
  gaps: [], blockers: [], ...over
});

const fetchByUrl = (pages: Record<string, () => Response>) => (async (input: string | URL | Request) => {
  const handler = pages[String(input)];
  if (!handler) throw new Error("unreachable");
  return handler();
}) as typeof fetch;

test("addresses on a private network are recognised", () => {
  for (const address of ["127.0.0.1", "10.2.3.4", "172.20.0.1", "192.168.0.10", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
    expect(isPrivateAddress(address), address).toBe(true);
  }
  for (const address of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:2800:220:1:248:1893:25c8:1946"]) expect(isPrivateAddress(address), address).toBe(false);
});

test("a source is accepted only when it opens and its content matches the claimed title", async () => {
  const fetchImpl = fetchByUrl({
    "https://example.edu/accelerator": () => page("Student Accelerator Program | Example University"),
    "https://example.edu/other": () => page("Cooking recipes for a quiet weekend")
  });
  const source = { id: "s", url: "https://example.edu/accelerator", title: "Student Accelerator Program", publisher: "", accessedOn: "2026-10-02" };
  expect(await verifySource(source, { fetchImpl, isPublicHost: publicHost })).toMatchObject({ ok: true });
  expect(await verifySource({ ...source, url: "https://example.edu/other" }, { fetchImpl, isPublicHost: publicHost })).toMatchObject({ ok: false, reason: expect.stringContaining("对不上") });
  expect(await verifySource({ ...source, url: "https://example.edu/missing" }, { fetchImpl, isPublicHost: publicHost })).toMatchObject({ ok: false, reason: "打不开" });
});

test("a host that resolves to a private address, or a redirect into one, is never requested", async () => {
  let requested = 0;
  const fetchImpl = (async () => { requested += 1; return new Response("", { status: 302, headers: { location: "https://intranet.example.com/x" } }); }) as typeof fetch;
  const source = { id: "s", url: "https://example.edu/a", title: "anything here", publisher: "", accessedOn: "2026-10-02" };
  expect(await verifySource(source, { fetchImpl, isPublicHost: async () => false })).toMatchObject({ ok: false });
  expect(requested).toBe(0);
  const privateAfterRedirect = await verifySource(source, { fetchImpl, isPublicHost: async (host) => host !== "intranet.example.com" });
  expect(privateAfterRedirect).toMatchObject({ ok: false, reason: expect.stringContaining("非公开") });
  expect(requested).toBe(1);
});

test("unverifiable sources are dropped with everything that depended only on them", async () => {
  const { rpc } = fakeRuntime([answer()]);
  const fetchImpl = fetchByUrl({ "https://example.edu/accelerator": () => page("Student Accelerator Program — apply by Nov 15") });
  const run = createDiligenceRunner(store, workspaceId, "C:\\repo", () => rpc, { fetchImpl, isPublicHost: publicHost, readCost: cost, now: NOW, webBlocker: () => undefined });
  const outcome = await run("startup");
  expect(outcome).toMatchObject({ state: "done", findings: 1, proposals: 1, droppedSources: 1 });
  const [report] = store.listDiligenceReports(workspaceId);
  expect(report).toMatchObject({ scope: "startup", status: "done" });
  expect((report!.sources as Array<{ id: string }>).map((source) => source.id)).toEqual(["s1"]);
  expect((report!.proposals as Array<{ id: string; status: string }>)).toEqual([expect.objectContaining({ id: "p1", status: "pending" })]);
  expect(report!.note).toContain("无法核实");
});

test("a report in which no source can be opened is a failure, and writes no conclusions", async () => {
  const { rpc } = fakeRuntime([answer()]);
  const run = createDiligenceRunner(store, workspaceId, "C:\\repo", () => rpc, { fetchImpl: fetchByUrl({}), isPublicHost: publicHost, readCost: cost, now: NOW, webBlocker: () => undefined });
  expect(await run("startup")).toMatchObject({ state: "blocked", code: "DILIGENCE_NO_VERIFIED_SOURCE" });
  expect(store.listDiligenceReports(workspaceId)[0]).toMatchObject({ status: "failed", findings: [], proposals: [] });
});

test("a line is researched once a week, and not at all without a profile or without budget", async () => {
  const { rpc, turns } = fakeRuntime([answer()]);
  const fetchImpl = fetchByUrl({ "https://example.edu/accelerator": () => page("Student Accelerator Program") });
  const run = createDiligenceRunner(store, workspaceId, "C:\\repo", () => rpc, { fetchImpl, isPublicHost: publicHost, readCost: cost, now: NOW, webBlocker: () => undefined });
  expect(await run("media")).toEqual({ state: "skipped", reason: "no_profile" });
  expect((await run("startup")).state).toBe("done");
  expect(await run("startup")).toEqual({ state: "skipped", reason: "recent_report" });
  expect(turns()).toBe(1);
  expect(linesDueForDiligence(store, workspaceId, NOW())).toEqual([]);
  expect(linesDueForDiligence(store, workspaceId, new Date("2026-10-10T12:00:00.000Z"))).toEqual(["startup"]);

  const broke = createDiligenceRunner(store, workspaceId, "C:\\repo", () => rpc, { fetchImpl, isPublicHost: publicHost, now: NOW, webBlocker: () => undefined,
    readCost: async () => ({ available: true, short: { usedPercent: 99 }, long: { usedPercent: 99 } }) as never });
  expect(await broke("startup", { force: true })).toMatchObject({ state: "blocked", code: "DILIGENCE_BUDGET_LOW" });
});

test("what the person already answered is sent back so it is not offered twice", async () => {
  const { rpc, prompts } = fakeRuntime([answer()]);
  const fetchImpl = fetchByUrl({ "https://example.edu/accelerator": () => page("Student Accelerator Program") });
  const run = createDiligenceRunner(store, workspaceId, "C:\\repo", () => rpc, { fetchImpl, isPublicHost: publicHost, readCost: cost, now: NOW, webBlocker: () => undefined });
  const ownerId = store.getWorkspaceOwnerId(workspaceId)!;
  store.saveDiligenceReport({ id: "old", ownerId, workspaceId, scope: "startup", question: "q", findings: [], sources: [], status: "done", runAt: "2026-09-01T00:00:00.000Z",
    proposals: [{ id: "x", title: "已经拒绝过的建议", status: "rejected" }] });
  await run("startup");
  expect(prompts()[0]).toContain("已经拒绝过的建议");
  expect(prompts()[0]).toContain("无法全职创业");
});

test("without the runtime's web host the run says exactly what is missing and spends nothing", async () => {
  const { rpc, turns } = fakeRuntime([answer()]);
  const run = createDiligenceRunner(store, workspaceId, "C:\\repo", () => rpc, { isPublicHost: publicHost, readCost: cost, now: NOW,
    webBlocker: () => ({ code: "WEB_RESEARCH_HOST_MISSING", message: "缺少 host" }) });
  expect(await run("startup")).toEqual({ state: "blocked", code: "WEB_RESEARCH_HOST_MISSING", message: "缺少 host" });
  expect(turns()).toBe(0);
  expect(store.listDiligenceReports(workspaceId)).toEqual([]);
});

test("a claim must be about the page it cites: the names in it have to appear there", () => {
  const nvidia = "inception program for startups nvidia no application fee no deadline".toLowerCase();
  expect(pageSupports("NVIDIA Inception 无申请费、无截止日。", nvidia)).toBe(true);
  expect(pageSupports("EF Hult Prize 的校园赛获胜团队须最晚于 2 月 28 日提交。", nvidia)).toBe(false);
  // Plain Chinese prose has nothing to test, so it is not refused on this ground.
  expect(pageSupports("该比赛只面向在读学生。", nvidia)).toBe(true);
});

test("a finding filed under a page that does not say it loses that source, and goes if it has no other", async () => {
  const { rpc } = fakeRuntime([answer({
    sources: [
      { id: "s1", url: "https://example.edu/accelerator", title: "Student Accelerator Program", publisher: "Example University", accessedOn: "2026-10-02" },
      { id: "s2", url: "https://example.org/other", title: "Other Programme Page", publisher: "Other", accessedOn: "2026-10-02" }
    ],
    findings: [
      { id: "f1", claim: "Student Accelerator 接受在读学生，申请截止 2026-11-15。", sourceIds: ["s1"], confidence: "high", staleWhen: "下一届开放时" },
      { id: "f2", claim: "Student Accelerator 的截止日是 2026-11-15。", sourceIds: ["s2"], confidence: "medium", staleWhen: "规则更新时" }
    ],
    proposals: [
      { id: "p1", title: "11/15 前提交学生孵化器申请", why: "符合在读学生身份", kind: "milestone", dueDate: "2026-11-15", basedOnFacts: [], findingIds: ["f1"] },
      { id: "p2", title: "按另一页的说法安排申请", why: "来自另一个页面", kind: "task", dueDate: "", basedOnFacts: [], findingIds: ["f2"] }
    ]
  })]);
  const fetchImpl = fetchByUrl({
    "https://example.edu/accelerator": () => page("Student Accelerator Program", "Open to enrolled students. Deadline 2026-11-15."),
    "https://example.org/other": () => page("Other Programme Page", "Nothing about that programme here at all.")
  });
  const run = createDiligenceRunner(store, workspaceId, "C:\\repo", () => rpc, { fetchImpl, isPublicHost: publicHost, readCost: cost, now: NOW, webBlocker: () => undefined });
  expect(await run("startup")).toMatchObject({ state: "done", findings: 1, proposals: 1 });
  const [report] = store.listDiligenceReports(workspaceId);
  expect((report!.findings as Array<{ id: string }>).map((finding) => finding.id)).toEqual(["f1"]);
  expect((report!.sources as Array<{ id: string }>).map((source) => source.id)).toEqual(["s1"]);
  expect(report!.note).toContain("对不上");
});
