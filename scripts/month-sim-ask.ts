/**
 * Reproduces one ask from a month simulation's end state (a copy): lists the asks at an instant and answers one by id with its
 * recommended option, printing what `answerAsk` says. For the report's ASK_NOT_FOUND finding. Run on a copy; it writes.
 *
 *   pnpm exec tsx scripts/month-sim-ask.ts <copy.db> <iso> [ask id]
 */
import { register } from "node:module";
register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
const [file, iso, askId] = process.argv.slice(2);
process.env.CROSSLINE_FIXED_NOW = iso!;
process.env.CROSSLINE_BACKGROUND_SOLVE = "off";
const { CrosslineStore } = await import("../packages/db/src/index");
const store = new CrosslineStore(file!);
(globalThis as { crosslineStore?: unknown }).crosslineStore = store;
const { loadAsks, collectAsks, answerAsk } = await import("../apps/web/lib/asks");
const ws = store.listWorkspaces().map((item) => ({ item, n: store.listWorkOrders(item.id).length })).sort((a, b) => b.n - a.n)[0]!.item.id;
const principalId = store.getWorkspaceOwnerId(ws)!;
const ctx = { principalId, workspaceId: ws, role: "owner", identity: { provider: "credential", issuer: "inspect", subject: principalId }, authMethod: "session",
  requestId: "inspect" } as import("../packages/core/src/index").AccessContext;
const now = new Date(iso!);
const listed = await loadAsks(ctx, now);
const collected = collectAsks(ctx, now);
console.log("listed", listed.map((ask) => `${ask.kind}:${ask.id}`).join(" "));
console.log("collected has it", collected.some((ask) => ask.id === askId), "listed has it", listed.some((ask) => ask.id === askId));
const ask = listed.find((item) => item.id === askId);
if (ask) {
  const option = ask.options.find((item) => item.recommended && !item.href) ?? ask.options.find((item) => !item.href);
  console.log("answer", option?.id, await answerAsk(ctx, ask.id, { optionIds: [option!.id] }, {}, now));
}
store.close();
