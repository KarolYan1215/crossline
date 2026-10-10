import type { ModelUsageSummary } from "@crossline/db";
import { BarChart, Sparkline } from "../ui/charts";

/** Each Skill by what it does for the person; no model names (decided 2026-10-07). */
const FUNCTION_LABEL: Record<string, string> = {
  "crossline-onboarding": "访谈", "crossline-milestone-architect": "里程碑设计", "crossline-goal-backplanner": "任务倒推",
  "crossline-flywheel-scout": "跨主线扩展", "crossline-automation-stripper": "收集分析", "crossline-manualbook-designer": "教程设计",
  "crossline-material-researcher": "资料检索", "crossline-material-writer": "教程写作", "crossline-milestone-gate": "验收判定",
  "crossline-weekly-insight": "每周洞察", "crossline-due-diligence": "网上查证", "crossline-background-facts": "背景整理",
  "crossline-plan-explainer": "排程说明", "crossline-assistant": "小助手", "crossline-agent": "助手任务", "crossline-step-planner": "步骤拆分",
  "crossline-validation-reviewer": "复核", "crossline-progress-judge": "进度判断", "crossline-input-router": "输入识别", "crossline-concierge": "输入框"
};
const label = (skill: string) => FUNCTION_LABEL[skill.replace(/^crossline:/, "")] ?? "其他";
const k = (n: number) => Math.round(n / 100) / 10;

/**
 * Model use over the last week by function: tokens as bars (hover for runs, average and longest time, failures and repairs) and the
 * daily total as a trend. It is the app's own count of what the runtime reported, not the account's quota.
 */
export function UsageCard({ summary, daily, days }: { summary: ModelUsageSummary[]; daily: Array<{ day: string; runs: number; totalTokens: number }>; days: number }) {
  const byFunction = new Map<string, { tokens: number; runs: number; failed: number; repairs: number; longest: number; seconds: number }>();
  for (const row of summary) {
    const key = label(row.skill);
    const current = byFunction.get(key) ?? { tokens: 0, runs: 0, failed: 0, repairs: 0, longest: 0, seconds: 0 };
    byFunction.set(key, { tokens: current.tokens + row.totalTokens, runs: current.runs + row.runs, failed: current.failed + row.failed,
      repairs: current.repairs + row.repairs, longest: Math.max(current.longest, row.longestSeconds), seconds: current.seconds + row.averageSeconds * row.runs });
  }
  const rows = [...byFunction].sort((a, b) => b[1].tokens - a[1].tokens);
  const total = rows.reduce((sum, [, row]) => sum + row.tokens, 0);
  const runs = rows.reduce((sum, [, row]) => sum + row.runs, 0);
  if (!rows.length) return <p className="muted">近 {days} 天没有模型调用。</p>;
  return <div className="st-usage">
    <div className="st-usage-head">
      <div className="ui-stat"><b>{k(total)}k</b><span>近 {days} 天 tokens</span></div>
      <div className="ui-stat"><b>{runs}</b><span>调用次数</span></div>
      <Sparkline label="每日 tokens" unit="k" width={160} height={36} values={daily.map((day) => k(day.totalTokens))}
        labels={daily.map((day) => `${day.day.slice(5)} · ${day.runs} 次`)} />
    </div>
    <BarChart label="按功能的 tokens" unit="k" data={rows.map(([name, row]) => ({ label: name, value: k(row.tokens),
      title: `${name}：${k(row.tokens)}k tokens · ${row.runs} 次 · 平均 ${Math.round(row.seconds / Math.max(1, row.runs))} 秒 · 最长 ${Math.round(row.longest)} 秒${row.failed ? ` · 失败 ${row.failed}` : ""}${row.repairs ? ` · 重试 ${row.repairs}` : ""}` }))} />
  </div>;
}
