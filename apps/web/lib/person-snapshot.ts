import "server-only";
import { formatInTimeZone } from "date-fns-tz";
import type { AccessContext } from "@crossline/core";
import { defaultIdentityPacks } from "@crossline/identity-packs";
import { effectiveSchedulePreferences, getStore, loadCurrentPlan, planToday, resolvedEstimate } from "./crossline";
import { countPending } from "./pending";

/** Hard cap on what goes into every turn: enough for a week's picture, small enough to resend each turn. */
export const SNAPSHOT_LIMIT = 9000;
const FACTS_PER_LINE = 8;

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * What 「问答」 knows about the person, rebuilt for every turn: now, their lines' approved milestones with
 * deadlines and days left, what is on this week's calendar and plan, what waits for them, and the facts
 * they confirmed. Asked 「我这周最该做什么？」 the widget used to answer with generic advice, because its
 * context held only the conversation — while the app knew the data was due on the 8th and the paper on
 * the 31st.
 *
 * Plain text, not a schema: it is read by the model, never parsed back. It carries no screen-activity
 * titles or segments (`activity-privacy.test.ts`), and it is data for the model to quote, not instructions.
 */
export async function personSnapshot(ctx: AccessContext, now = new Date()): Promise<string> {
  const store = getStore();
  const zone = effectiveSchedulePreferences(ctx).preferences.timeZone;
  const today = planToday(ctx, now);
  const labels = Object.fromEntries(defaultIdentityPacks().map((pack) => [pack.id, pack.label]));
  const label = (id: string) => labels[id] ?? id;
  const anchors = new Map(store.listMilestoneAnchors(ctx.workspaceId).map((anchor) => [anchor.milestoneId, anchor]));
  const milestones = store.listMilestones(ctx.workspaceId).filter((milestone) => milestone.status !== "archived");
  const byDeadline = (a: { id: string }, b: { id: string }) =>
    (anchors.get(a.id)?.deadline ?? "9999").localeCompare(anchors.get(b.id)?.deadline ?? "9999");
  const lines: string[] = [];

  lines.push(`现在：${formatInTimeZone(now, zone, "yyyy-MM-dd EEE HH:mm")}（${zone}）`);

  const approved = milestones.filter((milestone) => milestone.status === "approved").sort(byDeadline);
  lines.push("", "## 已批准的里程碑（按截止日）");
  if (!approved.length) lines.push("（还没有）");
  for (const milestone of approved) {
    const deadline = anchors.get(milestone.id)?.deadline;
    const left = deadline ? daysBetween(today, deadline) : undefined;
    lines.push(`- [${label(milestone.identityId)}] ${milestone.title}${deadline ? ` · 最晚 ${deadline}（${left! >= 0 ? `还剩 ${left} 天` : `已过 ${-left!} 天`}）` : " · 无截止"}`);
  }
  const drafts = milestones.filter((milestone) => milestone.status === "draft").sort(byDeadline);
  if (drafts.length) {
    lines.push("", "## 草稿里程碑（还没批准）");
    for (const milestone of drafts) lines.push(`- [${label(milestone.identityId)}] ${milestone.title}${anchors.get(milestone.id)?.deadline ? ` · 最晚 ${anchors.get(milestone.id)!.deadline}` : ""}`);
  }

  const plan = await loadCurrentPlan(ctx);
  const weekEnd = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
  const thisWeek = plan.blocks.filter((block) => block.day && block.day >= today && block.day < weekEnd)
    .sort((a, b) => `${a.day} ${a.start}`.localeCompare(`${b.day} ${b.start}`));
  const describe = (block: (typeof thisWeek)[number]) => `- ${block.day!.slice(5)} ${block.start}–${block.end} ${block.title}`;
  lines.push("", "## 未来 7 天：排给任务的时段");
  const scheduled = thisWeek.filter((block) => block.id.startsWith("scheduled:"));
  lines.push(...(scheduled.length ? scheduled.slice(0, 30).map(describe) : ["（还没有）"]));
  const proposed = thisWeek.filter((block) => block.id.startsWith("proposed:"));
  if (proposed.length) lines.push("", "## 未来 7 天：待批准方案的建议时段（批准后才算数）", ...proposed.slice(0, 20).map(describe));
  const fixed = thisWeek.filter((block) => !block.id.startsWith("scheduled:") && !block.id.startsWith("proposed:"));
  if (fixed.length) lines.push("", "## 未来 7 天：日历与课程里的固定安排", ...fixed.slice(0, 30).map(describe));

  const orders = store.listWorkOrders(ctx.workspaceId).filter((order) => !["archived", "accepted"].includes(order.state)
    && !(order.payload as { seeded?: boolean }).seeded);
  const titleOf = new Map(milestones.map((milestone) => [milestone.id, milestone.title]));
  const stateWords: Record<string, string> = { awaiting_plan_approval: "待批准", approved: "已批准", preparing: "备材料中",
    ready_for_human: "可开始", active: "进行中", evidence_review: "待验收", blocked: "被退回", captured: "刚收集", analyzing: "分析中" };
  if (orders.length) {
    lines.push("", "## 手上的任务");
    for (const order of orders.slice(0, 25)) {
      const estimate = resolvedEstimate(ctx, order);
      lines.push(`- [${label(order.identityId)}·${stateWords[order.state] ?? order.state}] ${order.intent}${titleOf.get(order.milestoneId) ? ` → ${titleOf.get(order.milestoneId)}` : ""} · 约 ${estimate.p50Minutes} 分`);
    }
  }

  const waiting = store.listWaitingItems(ctx.workspaceId, { state: "open" });
  if (waiting.length) {
    lines.push("", "## 在等别人的（到之前，依赖它的工作不排）");
    for (const item of waiting.slice(0, 10)) lines.push(`- ${item.who ? `${item.who}：` : ""}${item.title} · 预计${item.approximate ? "大约" : ""} ${item.expectedAt}${item.followUpAt > item.expectedAt ? `（已推迟到 ${item.followUpAt} 再问）` : ""}`);
  }

  const pending = countPending(ctx);
  if (pending.total) {
    const parts = [["作业方案", pending.workOrders], ["里程碑草稿", pending.milestoneDrafts], ["主线联系", pending.relations],
      ["暂定目标", pending.targets], ["计划差异", pending.planChanges]].filter(([, count]) => Number(count) > 0)
      .map(([name, count]) => `${name} ${count}`);
    lines.push("", `## 等你决定：共 ${pending.total} 项（${parts.join("、")}）`);
  }

  const facts = store.listProfileFacts(ctx.workspaceId).filter((fact) => fact.status === "confirmed");
  if (facts.length) {
    lines.push("", "## 你确认过的情况（每条线最多 8 条）");
    for (const identityId of [...new Set(facts.map((fact) => fact.identityId))]) {
      for (const fact of facts.filter((item) => item.identityId === identityId).slice(0, FACTS_PER_LINE)) {
        lines.push(`- [${label(identityId)}] ${fact.slot}：${fact.value.slice(0, 160)}`);
      }
    }
  }

  const text = lines.join("\n");
  return text.length > SNAPSHOT_LIMIT ? `${text.slice(0, SNAPSHOT_LIMIT - 20)}\n（以下省略）` : text;
}
