/**
 * Reads a month simulation's end state (scripts/month-sim.ts leaves its copy in the OS temp folder): each named task's steps as the
 * scheduler sees them. Read-only.
 *
 *   pnpm exec tsx scripts/month-sim-inspect.ts <copy.db> <order id prefix>...
 */
import { CrosslineStore, openNeedsOf } from "../packages/db/src/index";

const [file, ...prefixes] = process.argv.slice(2);
const store = new CrosslineStore(file!);
const ws = store.listWorkspaces().map((item) => ({ item, n: store.listWorkOrders(item.id).length })).sort((a, b) => b.n - a.n)[0]!.item.id;
// `--prep`: how the person's open steps are typed and how much preparation each open task gets (taskPreparation), by domain distance.
if (prefixes[0] === "--prep") {
  const { taskPreparation } = await import("../packages/core/src/index");
  const products: Record<string, number> = {}, levels: Record<string, number> = {};
  for (const plan of store.listStepPlans(ws)) {
    const order = store.getWorkOrder(ws, plan.workOrderId);
    if (!order || !["approved", "ready_for_human", "active"].includes(order.state)) continue;
    for (const step of plan.steps) if (step.executor !== "agent" && step.status === "planned") products[step.product ?? "(none)"] = (products[step.product ?? "(none)"] ?? 0) + 1;
    const level = taskPreparation({ title: order.intent, intent: order.intent, p50Minutes: order.estimate.p50Minutes, archetypeId: plan.archetypeId }, plan.steps).level;
    const far = /548|555|器件|电路|MoS|SRAM|忆阻/.test(`${order.intent} ${order.projectId}`) ? "far" : "near";
    levels[`${far}:${level}`] = (levels[`${far}:${level}`] ?? 0) + 1;
  }
  console.log({ products, levels });
}
// `--plan <iso>`: the schedule as the web app derives it at that instant (on a copy: run it on a copy, it writes the attention settings).
const planAt = prefixes.indexOf("--plan");
if (planAt >= 0) {
  const { register } = await import("node:module");
  register("data:text/javascript,export async function resolve(s,c,n){if(s==='server-only')return{url:'data:text/javascript,',shortCircuit:true};return n(s,c)}");
  process.env.CROSSLINE_FIXED_NOW = prefixes[planAt + 1]!;
  process.env.CROSSLINE_BACKGROUND_SOLVE = "off";
  (globalThis as { crosslineStore?: unknown }).crosslineStore = store;
  const web = await import("../apps/web/lib/crossline");
  const principalId = store.getWorkspaceOwnerId(ws)!;
  const ctx = { principalId, workspaceId: ws, role: "owner", identity: { provider: "credential", issuer: "inspect", subject: principalId }, authMethod: "session",
    requestId: "inspect" } as import("../packages/core/src/index").AccessContext;
  const plan = await web.loadCurrentPlan(ctx);
  for (const block of plan.blocks.filter((item) => item.id.startsWith("scheduled:")).sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`)).slice(0, 40))
    console.log(`${block.day} ${block.start}-${block.end} ${block.id.slice(10, 60)} ${block.title.slice(0, 30)}`);
  console.log("blockers", JSON.stringify(plan.schedule.blockers).slice(0, 800));
}
for (const prefix of prefixes.filter((item, index) => item !== "--prep" && !(planAt >= 0 && (index === planAt || index === planAt + 1)))) {
  const order = store.listWorkOrders(ws).find((item) => item.id.startsWith(prefix));
  if (!order) { console.log("none", prefix); continue; }
  const plan = store.getStepPlan(ws, order.id);
  console.log(`== ${order.state} ${order.id} ${order.intent.slice(0, 40)} due=${(order.payload as { dueDate?: string }).dueDate ?? ""}`);
  for (const step of plan?.steps ?? [])
    console.log(`   ${step.id} ${step.status} q${step.progressQuarter ?? 0} ${step.role} exec=${step.executor} owner=${step.owner ?? ""} sched=${step.schedulable} p50=${step.estimate.p50Minutes}`
      + ` dep=[${step.dependsOn.join(",")}] uses=[${(step.uses ?? []).join(",")}] provides=${step.provides ?? ""} open=[${plan ? openNeedsOf(plan, step).join(",") : ""}] ${step.title.slice(0, 24)}`);
}
store.close();
