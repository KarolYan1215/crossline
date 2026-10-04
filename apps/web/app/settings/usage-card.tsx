import { tierRoutes, SKILL_TIERS } from "@crossline/codex";
import type { ModelUsageSummary } from "@crossline/db";

const TIER_LABEL = { top: "顶档", mid: "中档", low: "低档" } as const;
const SKILL_LABEL: Record<string, string> = {
  "crossline-onboarding": "访谈", "crossline-milestone-architect": "里程碑设计", "crossline-goal-backplanner": "目标回推",
  "crossline-flywheel-scout": "飞轮扩展", "crossline-automation-stripper": "任务分析", "crossline-manualbook-designer": "手册流程设计", "crossline-material-researcher": "查资料", "crossline-material-writer": "手册写作",
  "crossline-milestone-gate": "里程碑闸门", "crossline-weekly-insight": "周洞察", "crossline-due-diligence": "网上查证",
  "crossline-background-facts": "背景事实", "crossline-plan-explainer": "排程解释", "crossline-assistant": "助手"
};
const label = (skill: string) => SKILL_LABEL[skill.replace(/^crossline:/, "")] ?? skill.replace(/^crossline:crossline-/, "");
const tokens = (n: number) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/**
 * What the app's own model calls cost over the last week, per Skill, and which model each tier maps to. This is
 * the app's own count from what the runtime reported, not the account's quota (that is a different number,
 * read from the account on the connections section).
 */
export function UsageCard({ summary, days }: { summary: ModelUsageSummary[]; days: number }) {
  const routes = tierRoutes();
  const total = summary.reduce((sum, row) => sum + row.totalTokens, 0);
  const runs = summary.reduce((sum, row) => sum + row.runs, 0);
  return <div className="usage">
    <p className="muted">
      {(Object.keys(routes) as Array<keyof typeof routes>).map((tier) => `${TIER_LABEL[tier]}：${routes[tier].model}${routes[tier].effort ? `（${routes[tier].effort}）` : ""}`).join("　")}
    </p>
    {summary.length === 0 ? <p className="muted">近 {days} 天还没有模型调用记录。</p> : <>
      <table className="usage-table">
        <thead><tr><th>用途</th><th>模型</th><th>次数</th><th>输入</th><th>输出</th><th>思考</th><th>平均 / 最长耗时</th><th>失败 / 重试</th></tr></thead>
        <tbody>{summary.map((row) => <tr key={`${row.skill}|${row.model}`}>
          <td>{label(row.skill)}{SKILL_TIERS[row.skill.replace(/^crossline:/, "")] ? "" : "（未分档）"}</td>
          <td>{row.model || "运行时默认"}</td><td>{row.runs}</td>
          <td>{tokens(row.inputTokens)}</td><td>{tokens(row.outputTokens)}</td><td>{tokens(row.reasoningTokens)}</td>
          <td>{row.averageSeconds} / {row.longestSeconds} 秒</td><td>{row.failed} / {row.repairs}</td>
        </tr>)}</tbody>
      </table>
      <p className="muted">近 {days} 天共 {runs} 次调用，{tokens(total)} tokens。</p>
    </>}
  </div>;
}
