/**
 * Many people taking the public quick test at once, against a running server (default the hosted one). Each simulated person does what
 * the page does: opens the landing page, hands in 32 answers with an appearance, says what they want to do, reads the result, fetches
 * the poster, waits for their figure, fetches the poster with it, and (unless --keep) deletes the result again.
 *
 *   pnpm exec tsx scripts/load-assess.ts --users 10            all at once
 *   pnpm exec tsx scripts/load-assess.ts --users 20 --ramp 60  spread over a minute
 *
 * Options: --base <url> (https://test.crossline.lol), --users <n> (10), --ramp <seconds> (0), --figure-wait <minutes> (15),
 * --keep (leave the results), --mail (tick 「发到邮箱」; off by default, the addresses are @example.com and never receive mail).
 *
 * Costs: every person is one image call to the configured image model (the daily budget, ASSESS_IMAGE_DAILY_LIMIT, still applies) and
 * at most one text-model call. All requests come from this machine's address, so the server's per-address limits apply (120 hand-ins
 * and 120 wants an hour): past them it answers RATE_LIMITED, which is reported as such, not as a fault.
 *
 * Behind an HTTP proxy, run with NODE_USE_ENV_PROXY=1 so fetch uses it. Exits 1 when any request failed for a reason other than a
 * limit, or a person was left without a result.
 */
import { QUIZ_ITEMS } from "../packages/core/src/assess";

type Step = "landing" | "submit" | "wants" | "result" | "poster" | "figure" | "posterWithFigure" | "delete";
type Sample = { step: Step; ms: number; status: number; code?: string };
type Person = { index: number; samples: Sample[]; figure?: string; figureMs?: number; error?: string };

const args = process.argv.slice(2);
const option = (name: string): string | undefined => { const at = args.indexOf(`--${name}`); return at >= 0 ? args[at + 1] : undefined; };
const flag = (name: string): boolean => args.includes(`--${name}`);
const base = (option("base") ?? "https://test.crossline.lol").replace(/\/$/, "");
const users = Math.max(1, Number(option("users") ?? 10));
const rampMs = Math.max(0, Number(option("ramp") ?? 0)) * 1000;
const figureWaitMs = Math.max(1, Number(option("figure-wait") ?? 15)) * 60_000;
const keep = flag("keep");
const mail = flag("mail");
const run = Date.now().toString(36);

const HAIR = ["short", "medium", "long", "curly", "tied"] as const;
const STYLE = ["casual", "minimal", "smart", "preppy", "street", "sporty", "techwear", "artsy", "chinese", "sweet", "cool"] as const;
const PICKS = ["research", "writing", "design", "build", "media", "teaching", "startup", "study"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request, timed; the body is read in full so the time includes the download. */
async function timed(person: Person, step: Step, path: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  const started = performance.now();
  let status = 0;
  let body: unknown;
  try {
    const response = await fetch(`${base}${path}`, { ...init, headers: { origin: base, ...(init.headers ?? {}) } });
    status = response.status;
    const type = response.headers.get("content-type") ?? "";
    body = type.includes("json") ? await response.json().catch(() => undefined) : (await response.arrayBuffer()).byteLength;
  } catch (error) {
    body = { code: `NETWORK ${(error as { cause?: { code?: string } }).cause?.code ?? (error as Error).message}` };
  }
  const code = typeof body === "object" && body && "code" in body ? String((body as { code: unknown }).code) : undefined;
  person.samples.push({ step, ms: Math.round(performance.now() - started), status, ...(code ? { code } : {}) });
  return { status, body };
}

async function person(index: number): Promise<Person> {
  const me: Person = { index, samples: [] };
  try {
    await timed(me, "landing", "/");
    // Answers vary per person so the types spread; startedAt is set as if the questions took a minute (the server's floor is 40 s).
    const answers = Object.fromEntries(QUIZ_ITEMS.map((item, at) => [item.id, ((at * 7 + index * 3) % 5) + 1]));
    const submission = {
      answers, email: `load-${run}-${index}@example.com`, sendEmail: mail, nickname: `压测${index}`, startedAt: Date.now() - 60_000, website: "",
      appearance: { presentation: (["female", "male", "neutral"] as const)[index % 3], hair: HAIR[index % HAIR.length], glasses: index % 2 === 0,
        skin: (["light", "medium", "deep"] as const)[index % 3], style: STYLE[index % STYLE.length], note: "" }
    };
    const submitted = await timed(me, "submit", "/api/results", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(submission) });
    const token = (submitted.body as { resultToken?: string } | undefined)?.resultToken;
    if (submitted.status !== 200 || !token) { me.error = `submit ${submitted.status} ${me.samples.at(-1)?.code ?? ""}`.trim(); return me; }
    const picks = [PICKS[index % PICKS.length]!, PICKS[(index + 3) % PICKS.length]!];
    await timed(me, "wants", `/api/results/${token}/wants`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ picks, text: index % 2 ? "把读书笔记做成播客" : "" }) });
    const first = await timed(me, "result", `/api/results/${token}`);
    const posterUrl = (first.body as { posterUrl?: string } | undefined)?.posterUrl;
    if (posterUrl) await timed(me, "poster", posterUrl);
    // The page polls for the figure; so does this, every five seconds, until it settles or the wait runs out.
    const waitStarted = performance.now();
    let state = (first.body as { avatar?: { state?: string } } | undefined)?.avatar?.state ?? "unknown";
    while ((state === "queued" || state === "drawing") && performance.now() - waitStarted < figureWaitMs) {
      await sleep(5_000);
      const polled = await fetch(`${base}/api/results/${token}`).then((response) => response.json()).catch(() => undefined) as { avatar?: { state?: string } } | undefined;
      state = polled?.avatar?.state ?? state;
    }
    me.figure = state === "queued" || state === "drawing" ? `still ${state}` : state;
    me.figureMs = Math.round(performance.now() - waitStarted);
    me.samples.push({ step: "figure", ms: me.figureMs, status: state === "ready" ? 200 : 0, code: me.figure });
    const settled = await fetch(`${base}/api/results/${token}`).then((response) => response.json()).catch(() => undefined) as { posterUrl?: string } | undefined;
    if (settled?.posterUrl) await timed(me, "posterWithFigure", settled.posterUrl);
    if (!keep) await timed(me, "delete", `/api/results/${token}`, { method: "DELETE" });
  } catch (error) {
    me.error = error instanceof Error ? error.message : String(error);
  }
  return me;
}

const percentile = (values: number[], p: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
};

console.log(`load-assess: ${users} people against ${base}${rampMs ? ` over ${rampMs / 1000} s` : " at once"}, run ${run}`);
const started = Date.now();
const people = await Promise.all(Array.from({ length: users }, async (_, index) => {
  if (rampMs) await sleep(Math.round((rampMs * index) / users));
  return person(index);
}));
const seconds = Math.round((Date.now() - started) / 1000);

const steps: Step[] = ["landing", "submit", "wants", "result", "poster", "figure", "posterWithFigure", "delete"];
console.log(`\nstep               n    ok   p50 ms   p95 ms   max ms   other answers`);
let faults = 0;
for (const step of steps) {
  const samples = people.flatMap((one) => one.samples.filter((sample) => sample.step === step));
  if (!samples.length) continue;
  const ok = samples.filter((sample) => sample.status >= 200 && sample.status < 300);
  const others = new Map<string, number>();
  for (const sample of samples) {
    if (sample.status >= 200 && sample.status < 300) continue;
    const key = step === "figure" ? sample.code ?? "?" : `${sample.status}${sample.code ? ` ${sample.code}` : ""}`;
    others.set(key, (others.get(key) ?? 0) + 1);
    if (step !== "figure" && sample.code !== "RATE_LIMITED") faults += 1;
  }
  const ms = samples.map((sample) => sample.ms);
  console.log(`${step.padEnd(17)}${String(samples.length).padStart(3)}${String(ok.length).padStart(6)}${String(percentile(ms, 50)).padStart(9)}${
    String(percentile(ms, 95)).padStart(9)}${String(Math.max(...ms)).padStart(9)}   ${[...others].map(([key, count]) => `${key} ×${count}`).join(", ")}`);
}
const figures = new Map<string, number>();
for (const one of people) if (one.figure) figures.set(one.figure, (figures.get(one.figure) ?? 0) + 1);
console.log(`\nfigures: ${[...figures].map(([state, count]) => `${state} ×${count}`).join(", ") || "none"}`);
const readyTimes = people.filter((one) => one.figure === "ready").map((one) => Math.round(one.figureMs! / 1000));
if (readyTimes.length) console.log(`figure ready after (s): p50 ${percentile(readyTimes, 50)}, p95 ${percentile(readyTimes, 95)}, max ${Math.max(...readyTimes)}`);
const lost = people.filter((one) => one.error);
for (const one of lost) console.log(`person ${one.index}: ${one.error}`);
console.log(`\n${users} people in ${seconds} s; ${faults} failed requests (limits not counted); ${lost.length} without a result`);
process.exit(faults || lost.some((one) => !one.error?.includes("RATE_LIMITED")) ? 1 : 0);
