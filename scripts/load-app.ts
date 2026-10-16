/**
 * Many people using the app at once, against a running server (default the hosted beta), in three phases:
 *
 *   1. pages  — signed-in people opening the working pages and the APIs those pages poll, several rounds each;
 *   2. visitors — people who are not signed in opening the sign-in page (the web app alone, no ledger);
 *   3. model — input-box turns sent at the same moment, each a question that needs the model, which the server runs at most
 *      `CROSSLINE_MODEL_CONCURRENCY` (2) at a time and queues the rest. A turn that comes back as an error card counts as failed.
 *
 *   pnpm exec tsx scripts/load-app.ts --session <storage-state.json> --users 10 --turns 4
 *
 * Options: --base <url> (https://app.crossline.lol), --session <file> (a Playwright storage state holding a signed-in session; or
 * CROSSLINE_LOAD_COOKIE="name=value; …"), --users <n> (10, phases 1 and 2), --rounds <n> (3), --turns <n> (4, phase 3; 0 skips it),
 * --only pages|visitors|model.
 *
 * Every signed-in request uses the one account the session belongs to, so the model phase writes its questions and answers into that
 * account's conversation for today; it asks questions only, and nothing an answer proposes is carried out without a click.
 * Behind an HTTP proxy, run with NODE_USE_ENV_PROXY=1. Exits 1 when any request failed.
 */
import { readFileSync } from "node:fs";

type Sample = { phase: string; what: string; ms: number; status: number; note?: string };

const args = process.argv.slice(2);
const option = (name: string): string | undefined => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const base = (option("base") ?? "https://app.crossline.lol").replace(/\/$/, "");
const users = Math.max(1, Number(option("users") ?? 10));
const rounds = Math.max(1, Number(option("rounds") ?? 3));
const turns = Math.max(0, Number(option("turns") ?? 4));
const only = option("only");
const sessionFile = option("session");
const cookie = process.env.CROSSLINE_LOAD_COOKIE ?? (sessionFile
  ? (JSON.parse(readFileSync(sessionFile, "utf8")) as { cookies: Array<{ name: string; value: string; domain: string }> }).cookies
    .filter((entry) => new URL(base).hostname.endsWith(entry.domain.replace(/^\./, ""))).map((entry) => `${entry.name}=${entry.value}`).join("; ")
  : "");

const PAGES = ["/", "/plan", "/milestones", "/workbench", "/approvals", "/settings"];
const POLLED = ["/api/pending", "/api/conversation", "/api/runtime", "/api/helper"];
const QUESTIONS = ["今天还剩哪几项要做？只回答，不要改任何东西。", "这周最近的截止是什么？只回答。", "我现在最该先做哪一件？只回答。",
  "主线里哪条线这周投入最少？只回答。", "列出待决事项里最急的一项。只回答。", "明天上午有什么安排？只回答。"];

const samples: Sample[] = [];
async function timed(phase: string, what: string, path: string, init: RequestInit & { signedIn?: boolean } = {}): Promise<unknown> {
  const started = performance.now();
  let status = 0;
  let body: unknown;
  let note: string | undefined;
  try {
    // A request that never answers is a failure to see, not a run that silently hangs until it is killed.
    const signal = AbortSignal.timeout(phase === "model" ? 20 * 60_000 : 3 * 60_000);
    const response = await fetch(`${base}${path}`, { ...init, redirect: "manual", signal,
      headers: { ...(init.signedIn === false ? {} : { cookie }), origin: base, ...(init.headers ?? {}) } });
    status = response.status;
    const type = response.headers.get("content-type") ?? "";
    body = type.includes("json") ? await response.json().catch(() => undefined) : await response.text();
    // A signed-in page that sends the person to sign in means the session did not count.
    if (status >= 300 && status < 400) note = `→ ${response.headers.get("location") ?? "?"}`;
  } catch (error) {
    note = (error as Error).name === "TimeoutError" ? "TIMEOUT" : `NETWORK ${(error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message}`;
  }
  samples.push({ phase, what, ms: Math.round(performance.now() - started), status, ...(note ? { note } : {}) });
  return body;
}

const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]! : 0;
};
const okStatus = (sample: Sample) => sample.status >= 200 && sample.status < 300 && !sample.note;

async function pages(): Promise<void> {
  if (!cookie) { console.log("pages: skipped, no session (--session or CROSSLINE_LOAD_COOKIE)"); return; }
  await Promise.all(Array.from({ length: users }, async (_, index) => {
    for (let round = 0; round < rounds; round += 1) {
      // Each person walks the pages in their own order, so the server sees a mix rather than one page at a time.
      for (const at of PAGES.keys()) await timed("pages", PAGES[(at + index) % PAGES.length]!, PAGES[(at + index) % PAGES.length]!);
      await Promise.all(POLLED.map((path) => timed("pages", path, path)));
    }
  }));
}

async function visitors(): Promise<void> {
  await Promise.all(Array.from({ length: users }, async () => {
    for (let round = 0; round < rounds; round += 1) await timed("visitors", "/login", "/login", { signedIn: false });
  }));
}

async function model(): Promise<void> {
  if (!cookie || !turns) { if (turns) console.log("model: skipped, no session"); return; }
  await Promise.all(Array.from({ length: turns }, async (_, index) => {
    const answer = await timed("model", "conversation turn", "/api/conversation/turn", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: QUESTIONS[index % QUESTIONS.length], mentions: [], page: { kind: "", entityId: "" } }) }) as
      { messages?: Array<{ role?: string; text?: string; payload?: { card?: { error?: unknown } } }> } | undefined;
    const reply = answer?.messages?.find((message) => message.role === "assistant");
    const last = samples.at(-1)!;
    if (reply?.payload?.card?.error) last.note = `error card: ${String(reply.payload.card.error).slice(0, 60)}`;
    else if (reply) last.note = undefined;
    console.log(`  turn ${index}: ${(last.ms / 1000).toFixed(1)} s ${last.status}${last.note ? ` ${last.note}` : ""} — ${(reply?.text ?? "").replace(/\s+/g, " ").slice(0, 60)}`);
  }));
}

let failed = 0;
/** The table for one phase, printed as soon as the phase ends so a later phase that hangs cannot take the earlier numbers with it. */
function summary(phase: string): void {
  const groups = new Map<string, Sample[]>();
  for (const sample of samples.filter((one) => one.phase === phase)) groups.set(sample.what, [...(groups.get(sample.what) ?? []), sample]);
  for (const [what, group] of groups) {
    const ms = group.map((sample) => sample.ms);
    const others = new Map<string, number>();
    for (const sample of group.filter((one) => !okStatus(one))) {
      const label = `${sample.status}${sample.note ? ` ${sample.note}` : ""}`;
      others.set(label, (others.get(label) ?? 0) + 1);
      failed += 1;
    }
    console.log(`${phase.padEnd(10)}${what.padEnd(23)}${String(group.length).padStart(3)}${String(group.filter(okStatus).length).padStart(6)}${
      String(percentile(ms, 50)).padStart(9)}${String(percentile(ms, 95)).padStart(9)}${String(Math.max(...ms)).padStart(9)}   ${
      [...others].map(([label, count]) => `${label} ×${count}`).join(", ")}`);
  }
}

console.log(`load-app: ${base}, ${users} people × ${rounds} rounds, ${turns} simultaneous model turns${cookie ? "" : " (no session)"}`);
console.log(`\nphase     what                     n    ok   p50 ms   p95 ms   max ms   other answers`);
const started = Date.now();
for (const [name, phase] of [["pages", pages], ["visitors", visitors], ["model", model]] as const) {
  if (only && only !== name) continue;
  const at = Date.now();
  await phase();
  summary(name);
  console.log(`  (${name}: ${Math.round((Date.now() - at) / 1000)} s)`);
}
console.log(`\n${samples.length} requests in ${Math.round((Date.now() - started) / 1000)} s; ${failed} failed`);
process.exit(failed ? 1 : 0);
