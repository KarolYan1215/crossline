/**
 * Energy model v2 (docs/energy-and-ecosystem.md §2) on a **copy** of the live ledger, nothing written to the real one: for every L/M/H
 * self-report whose last sleep is known, the level v1 (S from the last night only, no U, no W) and v2 (S carried across fourteen nights,
 * U and W) would have given — each with cut points fitted on the other reports only (leave one out) — and how often each matched what
 * the person said; then the sleep debt, the day capacity of the last fourteen days and the efficiency samples the completion check has
 * recorded so far.
 *
 *   pnpm exec tsx scripts/energy-v2-check.ts
 */
import { register } from "node:module";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const repoRoot = path.resolve(import.meta.dirname, "..");
const dataDir = mkdtempSync(path.join(tmpdir(), "crossline-energy-v2-check-"));
const Database = (await import("../packages/db/node_modules/better-sqlite3/lib/index.js")).default as unknown as new (file: string, options?: object) => { backup: (to: string) => Promise<unknown>; close: () => void };
const live = new Database(path.join(repoRoot, "data", "crossline.db"), { readonly: true });
await live.backup(path.join(dataDir, "crossline.db"));
live.close();
process.env.CROSSLINE_DATA_DIR = dataDir;
process.env.CROSSLINE_AUTO_PUBLISH = "off";
process.env.CROSSLINE_BACKGROUND_SOLVE = "off";

const { CrosslineStore } = await import("../packages/db/src/index");
const store = new CrosslineStore(path.join(dataDir, "crossline.db"));
(globalThis as { crosslineStore?: unknown }).crosslineStore = store;
const core = await import("../packages/core/src/index");
const { energyModel } = await import("../apps/web/lib/energy");
const { readAvailability } = await import("../apps/web/lib/crossline");

const workspace = store.listWorkspaces().find((item) => store.listWorkOrders(item.id).length > 0)!;
const ws = workspace.id;
const principalId = store.getWorkspaceOwnerId(ws)!;
const ctx = { principalId, workspaceId: ws, role: "owner", identity: { provider: "credential", issuer: "energy-v2-check", subject: principalId },
  authMethod: "session", requestId: "energy-v2-check" } as import("../packages/core/src/index").AccessContext;

const model = energyModel(ctx, readAvailability(ctx));
const { episodes, hourOf, phaseShift } = model;
// v1 as it stood before 2026-10-14: S at waking from the last night alone, onset taken as sixteen hours awake, plus C.
const v1 = (at: string): number | undefined => {
  const episode = core.lastSleepBefore(episodes, at);
  if (!episode) return undefined;
  const sleepHours = (Date.parse(episode.wakeAt) - Date.parse(episode.sleepAt)) / 3_600_000;
  const atOnset = 2.4 + (14.3 - 2.4) * Math.exp(-0.0353 * 16);
  const atWake = 14.3 - (14.3 - atOnset) * Math.exp(-0.381 * sleepHours);
  const awake = (Date.parse(at) - Date.parse(episode.wakeAt)) / 3_600_000;
  return 2.4 + (atWake - 2.4) * Math.exp(-0.0353 * awake) + 2.5 * Math.cos((2 * Math.PI * (hourOf(at) - (16.8 + phaseShift))) / 24);
};
const v2 = (at: string) => core.alertnessAt(at, episodes, hourOf, phaseShift);

const reports = store.listEnergyObservations(ws).filter((item) => item.source === "self_report" && item.level !== "uncalibrated")
  .map((item) => ({ at: item.observedAt, level: item.level as "low" | "medium" | "high" }));
const score = (name: string, value: (at: string) => number | undefined) => {
  const rows = reports.flatMap((report) => { const alertness = value(report.at); return alertness === undefined ? [] : [{ ...report, alertness }]; });
  let hits = 0;
  rows.forEach((row, index) => {
    const fitted = core.calibrate(rows.filter((_, other) => other !== index));
    const level = row.alertness < fitted.low ? "low" : row.alertness < fitted.high ? "medium" : "high";
    if (level === row.level) hits += 1;
  });
  console.log(`${name}: ${hits}/${rows.length} self-reports matched (leave-one-out cut points)`);
};
console.log(`workspace ${ws}: ${episodes.length} nights on record (${episodes.filter((item) => item.source === "screen").length} from the screen), ${reports.length} self-reports`);
score("v1", v1);
score("v2", v2);

const now = new Date();
const debt = core.sleepDebt(now.toISOString(), episodes);
console.log(`sleep need ${core.sleepNeed(episodes).toFixed(1)} h; debt over ${debt.nights} recorded nights: ${debt.hours.toFixed(1)} h total, ${debt.perNight.toFixed(2)} h/night weighted`);
for (let back = 13; back >= 0; back -= 1) {
  const at = new Date(now.getTime() - back * 86_400_000);
  const day = at.toISOString().slice(0, 10);
  const capacity = model.capacity(at.toISOString(), day);
  if (capacity.multiplier < 1) console.log(`  ${day}: capacity ${capacity.multiplier} — ${capacity.basis.join("；")}`);
}
const samples = store.listEvents(ws, { type: "block.confirmed" }).filter((event) => (event.payload as { energy?: unknown }).energy);
console.log(`completion checks carrying block energy: ${samples.length} (factors are learned only once the backtest beats 0.8/0.65)`);
store.close();
