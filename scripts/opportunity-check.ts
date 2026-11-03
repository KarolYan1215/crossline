/**
 * The opportunity agent's acceptance run for track A (docs/opportunity-agent.md §14, criteria 1 and 2), on a **copy** of the real ledger (the
 * live database is only read, through SQLite's online backup; nothing is written to it):
 *
 *   1  the research line's watches worked out from the person's own facts and milestones (§17.2); the summer research internship watch
 *      kept on the copy shows its 「预计 X 月开放」 waiting item and the day preparation starts;
 *   2  real postings fetched from public job boards (Greenhouse/Lever/Ashby), each term judged by code against the person's confirmed facts,
 *      and the eligible or still-open ones shown as the `opportunity_offer` cards the web would put up.
 *
 *   pnpm exec tsx scripts/opportunity-check.ts [boards|needs|postings|all] [--runtime=stand-in|resident|state:<dir>]
 *
 * `--runtime` picks where the two Skills run:
 *   stand-in (default)  no model: a needs answer written here from the ledger's real fact ids, and a reading built mechanically from each real
 *                       posting's own sentences (labelled as such in the output). Shows the pipeline, not the model.
 *   state:<dir>         a Codex home of its own under <dir> (`CROSSLINE_STATE_DIR`), signed in there beforehand; the resident app is untouched.
 *   resident            the machine's own Codex home, shared with the resident worker: installing this checkout's plugin replaces the resident
 *                       runtime's copy, so set `CROSSLINE_RESTORE_MARKETPLACE` to the resident checkout's `marketplace.json` to install it back.
 * Real runs spend quota; never run as a side effect.
 */
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const repoRoot = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const step = args.find((arg) => !arg.startsWith("--")) ?? "all";
const runtime = args.find((arg) => arg.startsWith("--runtime="))?.slice("--runtime=".length) ?? "stand-in";
if (runtime.startsWith("state:")) process.env.CROSSLINE_STATE_DIR = runtime.slice("state:".length);

const liveLedger = process.env.CROSSLINE_LIVE_LEDGER ?? path.join(repoRoot, "data", "crossline.db");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-opportunity-check-"));
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(liveLedger, { readonly: true, fileMustExist: true });
await live.backup(path.join(dataDir, "crossline.db"));
live.close();
process.env.CROSSLINE_DATA_DIR = dataDir;

const core = await import("../packages/core/src/index");
const { CrosslineStore, decideWatch, readWatchList, waitingIdForNeed } = await import("../packages/db/src/index");
const { deriveWatches, runWatch, OPPORTUNITY_NEEDS, OPPORTUNITY_READER } = await import("../apps/worker/src/opportunities");
const { fakeRuntime } = await import("../apps/worker/src/testing/fake-runtime");

const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
const ws = store.listWorkspaces().find((item) => store.getSetting(item.id, core.RUNTIME_OWNER_SETTING))?.id
  ?? store.listWorkspaces().map((item) => ({ id: item.id, n: store.listProfileFacts(item.id).length })).sort((a, b) => b.n - a.n)[0]!.id;
const owner = store.getWorkspaceOwnerId(ws)!;
const line = "research";
const NOW = new Date();
const today = NOW.toISOString().slice(0, 10);
const heading = (text: string) => console.info(`\n== ${text}`);

// Boards a computer-architecture PhD's summer research internship plausibly sits on; all public, read without a login.
const BOARDS: Array<{ provider: "greenhouse" | "lever" | "ashby"; board: string }> = [
  { provider: "greenhouse", board: "anthropic" }, { provider: "greenhouse", board: "cerebrassystems" }, { provider: "greenhouse", board: "tenstorrent" },
  { provider: "greenhouse", board: "sambanovasystems" }, { provider: "lever", board: "groq" }, { provider: "ashby", board: "etched" },
  { provider: "greenhouse", board: "neuralink" }, { provider: "ashby", board: "openai" }
];

async function liveBoards(): Promise<Array<{ provider: "greenhouse" | "lever" | "ashby"; board: string; postings: ReturnType<typeof core.parsePostings> }>> {
  const out = [];
  for (const { provider, board } of BOARDS) {
    const response = await fetch(core.boardUrl(provider, board)).catch(() => undefined);
    if (!response?.ok) { console.info(`${provider}/${board}: ${response?.status ?? "unreachable"}`); continue; }
    const postings = core.parsePostings(provider, await response.json(), "");
    console.info(`${provider}/${board}: ${postings.length} internship postings${postings.length ? ` — ${postings.slice(0, 3).map((item) => item.title).join(" | ")}` : ""}`);
    out.push({ provider, board, postings });
  }
  return out;
}

/** The stand-in reader: each posting's own sentences about degree or enrollment become terms, quoted verbatim (so code can check them). */
function standInReading(prompt: string): string {
  const input = JSON.parse(prompt.slice(prompt.indexOf("{"))) as { pages: Array<{ pageId: string; url: string; text: string }> };
  const related = /engineer|research|chip|hardware|inference|firmware|simulation|design|architecture|silicon|asic|\bic\b/i;
  const items = input.pages.filter((page) => related.test(page.text.split("\n")[0] ?? "")).map((page) => {
    const sentences = page.text.split(/(?<=[.!?。])\s+|\n/).map((item) => item.trim()).filter((item) => item.length > 12 && item.length < 280);
    const degree = sentences.find((item) => /\b(ph\.?d|doctoral|graduate student|master'?s|bachelor'?s|enrolled|pursuing)\b/i.test(item));
    const stages = degree ? ([[/bachelor|undergrad/i, "undergraduate"], [/master/i, "masters"], [/ph\.?d|doctoral/i, "phd"], [/graduate student/i, "graduate"]] as const)
      .filter(([pattern]) => pattern.test(degree)).map(([, stage]) => stage) : [];
    const eligibility = degree && stages.length ? [{ dim: "degree_stage", rule: degree.slice(0, 200), quote: degree,
      accepts: { kind: "one_of", values: stages, min: -1, max: -1 } }] : [];
    return { pageId: page.pageId, url: page.url, title: page.text.split("\n")[0]!.slice(0, 120), organizer: new URL(page.url).hostname, kind: "application",
      deadlines: [], startsAt: { day: "", quote: "" }, cost: { known: false, amount: 0, currency: "", quote: "" }, location: page.text.split("\n")[1] ?? "",
      eligibility, needsAccount: true, materials: [], consents: [], registrationUrl: "" };
  });
  return JSON.stringify({ items, blocked: items.length ? "" : "no page" });
}

let supervisor: { client: unknown; stop: () => Promise<void> } | undefined;
async function realClient() {
  if (supervisor) return supervisor.client;
  const { startCodexSupervisor } = await import("../packages/codex/src/index");
  supervisor = await startCodexSupervisor({ port: Number(process.env.CROSSLINE_CODEX_SUPERVISOR_PORT ?? 3399),
    plugin: { name: "crossline", marketplacePath: path.join(repoRoot, "skills", "marketplace", ".agents", "plugins", "marketplace.json"), cwd: repoRoot,
      requiredSkills: [OPPORTUNITY_NEEDS, OPPORTUNITY_READER] } }) as never;
  return supervisor!.client;
}

try {
  heading(`账本副本 ${dataDir}，工作区 ${ws}，运行时 ${runtime}`);
  const applicant = core.applicantFrom(store.listProfileFacts(ws));
  console.info(`程序读到的申请人：${JSON.stringify(Object.fromEntries(Object.entries(applicant).filter(([key]) => key !== "terms")))}`);

  if (step === "boards" || step === "all" || step === "postings") heading("公开招聘接口（真实请求）");
  const boards = step === "needs" ? [] : await liveBoards();

  if (step === "needs" || step === "all") {
    const facts = store.listProfileFacts(ws).filter((fact) => fact.status === "confirmed" && (fact.identityId === line || fact.identityId === "person"));
    const factIds = (slots: string[]) => facts.filter((fact) => !fact.projectId && slots.includes(fact.slot)).map((fact) => `${fact.identityId}/${fact.projectId}/${fact.slot}`);
    const withBoards = boards.filter((item) => item.postings.length).slice(0, 3);
    const standInWatches = JSON.stringify({ blocked: "", watches: [{
      key: "summer-research-internship", title: "明年暑期研究实习",
      why: "博士阶段刚开始、方向为神经形态计算的软硬件协同设计；一段工业界研究实习检验架构想法并积累合作。",
      factIds: factIds(["what", "stage", "positioning"]), milestoneIds: [], query: "硬件与 AI 公司的暑期研究实习（体系结构、加速器、神经形态）",
      judge: "研究型实习，面向在读博士，方向与体系结构或加速器相关", tools: ["ats_board", "deadline_list"],
      targets: [...withBoards.map((item) => ({ tool: "ats_board", provider: item.provider, board: item.board, query: "" })),
        { tool: "deadline_list", list: "ccfddl", query: "ISCA" }],
      everyDays: 3, horizonDays: 300, leadDays: 30, prescreen: [],
      cycle: { opensMonth: 9, closesMonth: 12, basis: "往年硬件与 AI 公司的暑期研究实习多在 9–12 月开放", sourceUrl: "https://www.anthropic.com/careers" }
    }] });
    const client = runtime === "stand-in" ? fakeRuntime([standInWatches], OPPORTUNITY_NEEDS).rpc : await realClient();
    heading(`标准 1：推导「${line}」线的监视项${runtime === "stand-in" ? "（替身回答：本脚本按账本真实事实写的，不是模型）" : "（真模型）"}`);
    const started = Date.now();
    const derived = await deriveWatches(store, ws, line, { client: () => client as never, cwd: repoRoot,
      ...(runtime === "stand-in" ? { webBlocker: () => undefined } : {}) });
    console.info(`推导结果（${Math.round((Date.now() - started) / 1000)} 秒）：${JSON.stringify(derived)}`);
    const lineWatches = () => readWatchList(store, ws).filter((item) => item.lineId === line);
    for (const watch of lineWatches()) {
      console.info(JSON.stringify({ id: watch.id, title: watch.title, state: watch.state, factIds: watch.basis.factIds, cycle: watch.cycle, prepStartsOn: watch.prepStartsOn,
        targets: (watch.targets ?? []).map((target) => target.tool) }));
    }
    const summer = lineWatches().find((item) => item.cycle && /实习|intern/i.test(item.title)) ?? lineWatches().find((item) => item.cycle);
    if (!summer) console.info("没有推出周期性的实习监视项。");
    else {
      decideWatch(store, ws, owner, summer.id, "active", NOW);
      const waiting = store.listWaitingItems(ws).find((item) => item.id === waitingIdForNeed(summer.id));
      heading("副本上按「盯住」后");
      console.info(JSON.stringify({ watch: summer.title, state: lineWatches().find((item) => item.id === summer.id)?.state, prepStartsOn: summer.prepStartsOn,
        waiting: waiting && { title: waiting.title, expectedAt: waiting.expectedAt, approximate: waiting.approximate, state: waiting.state } }, null, 1));
    }
  }

  if (step === "postings" || step === "all") {
    const kept = readWatchList(store, ws).find((item) => item.lineId === line && item.state === "active" && (item.targets ?? []).some((target) => target.tool === "ats_board"));
    const fallback: core.StoredWatch = { id: "need:research:check", lineId: line, title: "暑期研究实习", why: "核对用", origin: "person",
      basis: { factIds: [], milestoneIds: [], opportunityIds: [] }, query: "暑期研究实习", judge: "研究型实习", tools: ["ats_board"], explore: false,
      targets: boards.filter((item) => item.postings.length).slice(0, 3).map((item) => ({ tool: "ats_board" as const, provider: item.provider, board: item.board, query: "" })),
      everyDays: 3, horizonDays: 300, state: "active", stats: core.emptyStats(), createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
      leadDays: 30, prescreen: [], weight: 1, strictness: 0 };
    const watch = kept ?? fallback;
    const client = runtime === "stand-in" ? fakeRuntime([(prompts) => standInReading(prompts.at(-1)!)], OPPORTUNITY_READER).rpc : await realClient();
    heading(`标准 2：读真实岗位并逐条判定资格${runtime === "stand-in" ? "（读页替身：按岗位原文机械摘句，不是模型）" : "（真模型读页）"}`);
    const started = Date.now();
    const result = await runWatch(store, ws, watch, { client: () => client as never, cwd: repoRoot, now: () => NOW });
    console.info(`运行结果（${Math.round((Date.now() - started) / 1000)} 秒）：${JSON.stringify(result)}`);
    for (const row of store.listOpportunities(ws)) {
      console.info(JSON.stringify({ title: row.title, url: row.url, via: row.foundVia, deadline: core.nextDeadline(row, today) ?? "",
        terms: row.terms.map((term) => ({ dim: term.dim, quote: term.quote.slice(0, 120), accepts: term.accepts.values })), verdict: row.verdict }));
    }
    // The cards the web would show (the same function the 待确认 page calls), on the copy.
    const { opportunityOfferAsks } = await import("../apps/web/lib/opportunities");
    const asks = await opportunityOfferAsks({ workspaceId: ws, principalId: owner } as never, NOW);
    heading(`询问卡 ${asks.length} 张`);
    for (const ask of asks.slice(0, 6)) console.info(JSON.stringify({ title: ask.title, why: ask.why, options: ask.options.map((option) => option.label) }));
  }
} finally {
  if (supervisor) {
    const restore = process.env.CROSSLINE_RESTORE_MARKETPLACE;
    if (runtime === "resident" && restore) {
      await (supervisor.client as { request: (method: string, params: object) => Promise<unknown> }).request("plugin/install", { marketplacePath: restore, pluginName: "crossline" })
        .catch((error) => console.warn("restore failed", error));
      console.info(`已用 ${restore} 恢复常驻运行时的 crossline 插件。`);
    }
    await supervisor.stop();
  }
  store.close();
  console.info(`\n账本副本：${dataDir}`);
}
