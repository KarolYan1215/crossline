/**
 * Where the opportunity agent's two tracks meet (docs/opportunity-agent.md §9–§11), end to end on a **copy** of the real ledger (the live
 * database is only read, through SQLite's online backup) and against **local stand-in pages**, never a real site:
 *
 *   报名  the offer card's 报名 → the form queue → the form service fills the free event and submits → the confirmation mail from the
 *         registration host confirms the run, the opportunity and the calendar event;
 *   申请  the offer card's 申请 → the milestone 「提交 … 申请」 → its preparation task completed with a statement file → the 「准备做完了，要
 *         代填吗？」 card → 代填申请 → the form service fills the application with the statement as the draft and stops before submitting →
 *         the person submits in the window (simulated by the confirmation mail arriving) → confirmed.
 *
 * At each step it prints what the person would see: the card, the 小帮手's calls and the weekly review's form list.
 *
 *   pnpm exec tsx scripts/opportunity-flow-check.ts
 *
 * No model runs: the filler and the checker are stand-ins that read the page snapshot by rule (labelled in the output). The browser is a
 * headless local Chrome with the private-address refusal lifted for 127.0.0.1 only, as the form service's own tests do.
 */
import { register } from "node:module";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { listenForBrowser } from "../apps/worker/src/browser-port";
import { tmpdir } from "node:os";
import path from "node:path";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const repoRoot = path.resolve(import.meta.dirname, "..");
const liveLedger = process.env.CROSSLINE_LIVE_LEDGER ?? path.join(repoRoot, "data", "crossline.db");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-opportunity-flow-"));
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(liveLedger, { readonly: true, fileMustExist: true });
await live.backup(path.join(dataDir, "crossline.db"));
live.close();
process.env.CROSSLINE_DATA_DIR = dataDir;
// The web's requests to the worker (the backplan after 申请) must never reach the resident worker: with no capability secret they fail at once.
delete process.env.CROSSLINE_SUPERVISOR_CAPABILITY_SECRET;

const core = await import("../packages/core/src/index");
const { CrosslineStore, readFormRuns } = await import("../packages/db/src/index");
const { createFormService } = await import("../apps/worker/src/form-service");
const { openFormBrowser } = await import("../apps/worker/src/form-browser");
const { findBrowser } = await import("../apps/worker/src/node/browser");
const chrome = findBrowser();
if (!chrome) { console.error("no local Chrome or Edge"); process.exit(2); } // i18n-ignore: a script

// Stand-in pages: a free event and an application form, each with its confirmation page.
let posted: string[] = [];
const server = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", () => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (request.method === "POST") { posted.push(`${request.url} ${decodeURIComponent(body.replace(/\+/g, " "))}`); }
    if (request.url === "/event/done") return response.end(`<h1>You're registered for Madison AI Night!</h1>`);
    if (request.url === "/apply/done") return response.end(`<h1>Application received</h1><p>Thank you for applying to the Summer Research Internship.</p>`);
    if (request.url?.startsWith("/apply")) return response.end(`<h1>Summer Research Internship</h1><form method="post" action="/apply/done">
      <label>Full name <input name="name"></label><label>Email <input name="email"></label>
      <label>Why this internship <textarea name="why"></textarea></label><button type="submit">Submit application</button></form>`);
    response.end(`<h1>Madison AI Night</h1><p>Free. Thursday 6:00 PM.</p><form method="post" action="/event/done">
      <label>Full name <input name="name"></label><label>Email <input name="email"></label><button type="submit">Register</button></form>`);
  });
});
const base = `http://127.0.0.1:${await listenForBrowser(server)}`;

const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
globalThis.crosslineStore = store;
const ws = store.listWorkspaces().find((item) => store.getSetting(item.id, core.RUNTIME_OWNER_SETTING))?.id ?? store.listWorkspaces()[0]!.id;
const owner = store.getWorkspaceOwnerId(ws)!;
const ctx = { workspaceId: ws, principalId: owner, role: "owner", locale: "zh", requestId: "flow-check" } as never;
const heading = (text: string) => console.info(`\n== ${text}`);
const NOW = new Date();
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString().slice(0, 10);

const secrets = new Map<string, string>();
// Stand-in filler: each textbox by its label, a textarea from the first draft, then the page's one button. Not a model.
const propose = async (context: import("../packages/core/src/index").FormFillContext): Promise<import("../packages/core/src/index").FormFillAnswer> => {
  const named = [...context.snapshot.matchAll(/- (textbox|button) "([^"]+)"/g)].map((match) => ({ role: match[1]!, name: match[2]! }));
  const actions = named.flatMap((node): import("../packages/core/src/index").FormFillAnswer["actions"] => {
    if (node.role === "button") return [{ op: "submit", target: node, value: null, why: "the page's button" }];
    if (/email/i.test(node.name)) return [{ op: "fill", target: node, value: { slot: "email" }, why: "" }];
    if (/name/i.test(node.name)) return [{ op: "fill", target: node, value: { slot: "full_name" }, why: "" }];
    return context.drafts[0] ? [{ op: "fill", target: node, value: { draft: context.drafts[0].id }, why: "a long answer from the approved draft" }] : [];
  });
  return { pageKind: "form", note: "stand-in", actions };
};
const forms = createFormService({ store, secrets: { read: async (w, name) => secrets.get(`${w}/${name}`), write: async (w, name, value) => { secrets.set(`${w}/${name}`, value); },
  remove: (w, name) => { secrets.delete(`${w}/${name}`); } }, cwd: repoRoot, dataDir, client: () => undefined, owner: () => ws, screen: true,
  profilesRoot: () => path.join(dataDir, "profiles"), executable: () => chrome,
  open: (options) => openFormBrowser({ ...options, headless: true, allow: async (url: string) => new URL(url).hostname === "127.0.0.1" }),
  models: () => ({ propose, check: async () => ({ ok: true, problems: [] }) }) });
const waitFor = async (done: () => boolean, ms = 90_000) => { const end = Date.now() + ms; while (!done() && Date.now() < end) { await forms.pass(ws); await new Promise((resolve) => setTimeout(resolve, 300)); } };

const { opportunityOfferAsks, answerOpportunityOffer, opportunityApplyReadyAsks, answerOpportunityApplyReady, loadOpportunityWeek } = await import("../apps/web/lib/opportunities");
const { personCalls } = await import("../apps/web/lib/person-calls");
const { completeWorkOrderExecution } = await import("../apps/web/lib/crossline");
const show = (label: string) => {
  const runs = readFormRuns(store, ws).filter((run) => run.opportunity.url.startsWith(base));
  console.info(`  [${label}] 代填：${runs.map((run) => `${run.opportunity.title}=${core.FORM_STATE_LABEL[run.state]}${run.stoppedFor ? `（${run.stoppedFor}）` : ""}`).join("；") || "无"}`);
  console.info(`  [${label}] 小帮手：${personCalls(ctx, new Date(), false).filter((call) => call.id.startsWith("form:")).map((call) => `${call.urgent ? "急 " : ""}${call.text}`).join("；") || "无"}`);
  console.info(`  [${label}] 周复盘：${loadOpportunityWeek(ctx).forms.filter((form) => runs.some((run) => run.id === form.id)).map((form) => `${form.title} ${core.FORM_STATE_LABEL[form.state]}`).join("；")}`);
};
const failures: string[] = [];
const expect = (ok: boolean, what: string) => { console.info(`  ${ok ? "✓" : "✗"} ${what}`); if (!ok) failures.push(what); };

try {
  heading(`账本副本 ${dataDir}，本人工作区 ${ws}；替身页面 ${base}；模型为按规则读快照的替身`);
  await forms.handle("POST", "/v1/apply-profile/email", ws, { value: "flow-check@example.edu" });
  await forms.handle("POST", "/v1/apply-profile/full_name", ws, { value: "Flow Check" });
  const opportunity = (over: Partial<import("../packages/core/src/index").Opportunity>) => ({ lineId: "research", organizer: "Stand-in Org",
    registrationHost: "127.0.0.1", deadlines: [], cost: null, eligibility: [], needsAccount: false, materials: [], consents: [], foundVia: "web" as const,
    foundAt: NOW.toISOString(), ...over }) as import("../packages/core/src/index").Opportunity;
  store.saveOpportunity(ws, { opportunity: opportunity({ id: "flow-event", key: `flow|event|${base}`, kind: "event", title: "Madison AI Night", url: `${base}/event`,
    startsAt: { day: day(10), quote: "Thursday 6:00 PM" }, cost: { amount: 0, currency: "USD", quote: "Free" } }), terms: [], verdict: { state: "eligible", basis: [] } });
  store.saveOpportunity(ws, { opportunity: opportunity({ id: "flow-apply", key: `flow|apply|${base}`, kind: "application", title: "Summer Research Internship", url: `${base}/apply`,
    deadlines: [{ day: day(20), quote: `Applications close on ${day(20)}` }], materials: ["研究陈述"] }), terms: [], verdict: { state: "eligible", basis: [] } });

  heading("报名：免费活动");
  const cards = opportunityOfferAsks(ctx, NOW).filter((ask) => ask.entityId.startsWith("flow-"));
  const event = cards.find((ask) => ask.entityId === "flow-event")!;
  console.info(`  卡片：${event.title}｜${event.options.map((option) => `${option.label}（${option.detail ?? ""}）`).join("｜")}`);
  expect(answerOpportunityOffer(ctx, event, "register", {}, NOW).ok, "报名写进代填队列");
  show("排队");
  await waitFor(() => ["submitted", "confirmed"].includes(readFormRuns(store, ws).find((run) => run.opportunityId === "flow-event")?.state ?? ""));
  show("填完");
  expect(posted.some((line) => line.startsWith("/event/done") && line.includes("flow-check@example.edu") && line.includes("Flow Check")), "替身页面收到了资料卡的姓名和邮箱");
  await forms.onNewMail(ws, [{ from: "Madison AI", fromAddress: "events@127.0.0.1", subject: "You're registered for Madison AI Night", snippet: "", date: day(0) }]);
  const eventRun = readFormRuns(store, ws).find((run) => run.opportunityId === "flow-event");
  expect(eventRun?.state === "confirmed", "确认邮件或确认页让报名变为已确认");
  expect(Boolean(store.listOpportunities(ws, { id: "flow-event" })[0]?.confirmedBy), "机会本身也标为已确认");
  expect((JSON.parse(store.getSetting(ws, core.FIXED_EVENTS) ?? "[]") as Array<{ id: string }>).some((item) => item.id === "opportunity-flow-event"), "活动进了日历");
  show("确认");

  heading("申请：准备做完后才问代填");
  const apply = opportunityOfferAsks(ctx, NOW).find((ask) => ask.entityId === "flow-apply")!;
  expect(answerOpportunityOffer(ctx, apply, "apply", {}, NOW).ok, "申请写了已批准的里程碑");
  const milestoneId = (store.listEvents(ws, { type: "opportunity.milestone_written", entityId: "flow-apply" })[0]?.payload as { milestoneId: string }).milestoneId;
  // What the backplan would write (the worker's backplanner is not run on the copy): one preparation task and the person's submission.
  const task = (id: string, intent: string) => store.saveWorkOrder({ id, ownerId: owner, workspaceId: ws, identityId: apply.line ?? "research", projectId: "", milestoneId, intent,
    state: "active", riskTier: "milestone", estimate: { p25Minutes: 30, p50Minutes: 60, p85Minutes: 90, source: "llm_prior", observationCount: 0, confidence: "low" }, payload: {} });
  task("flow-statement", "写研究陈述");
  task("flow-submit", "在官网提交申请");
  expect(opportunityApplyReadyAsks(ctx, NOW).every((ask) => ask.entityId !== "flow-apply"), "准备没做完时不问代填");
  const statement = path.join(dataDir, "statement.md");
  writeFileSync(statement, "I want to spend the summer on neuromorphic accelerators because my thesis measures spike-timing energy on real silicon.");
  const done = completeWorkOrderExecution(ctx, "flow-statement", [{ kind: "file", uri: new URL(`file:///${statement.replace(/\\/g, "/")}`).href, description: "研究陈述" }]);
  expect(done.ok, "准备任务按「完成」交付并验收");
  const ready = opportunityApplyReadyAsks(ctx, NOW).find((ask) => ask.entityId === "flow-apply");
  console.info(`  卡片：${ready?.title}｜${ready?.why}`);
  expect(Boolean(ready), "准备做完后出现「要代填吗」");
  expect(answerOpportunityApplyReady(ctx, ready!, "fill", NOW).ok, "代填申请写进队列");
  await waitFor(() => ["ready_to_submit", "waiting_person"].includes(readFormRuns(store, ws).find((run) => run.opportunityId === "flow-apply")?.state ?? ""));
  const applyRun = readFormRuns(store, ws).find((run) => run.opportunityId === "flow-apply");
  show("填完");
  expect(applyRun?.state === "ready_to_submit", "申请停在提交前");
  expect(!posted.some((line) => line.startsWith("/apply/done")), "申请没有被自动提交");
  expect(Boolean(applyRun?.checklist?.some((item) => /draft|文稿|陈述|statement/i.test(JSON.stringify(item)))), "核对清单列出了用文稿填的长回答");
  await forms.onNewMail(ws, [{ from: "Stand-in Org", fromAddress: "careers@127.0.0.1", subject: "Application received: Summer Research Internship", snippet: "", date: day(0) }]);
  const after = readFormRuns(store, ws).find((run) => run.opportunityId === "flow-apply");
  expect(after?.state === "confirmed" && after.submittedBy === "person", "本人在窗口里提交后，回执邮件把申请确认为本人提交");
  show("确认");
} finally {
  await forms.closeAll();
  server.close();
  store.close();
}
heading(failures.length ? `未通过 ${failures.length} 项：${failures.join("；")}` : "全部通过");
process.exit(failures.length ? 1 : 0);
