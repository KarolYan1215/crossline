"use client";

import type { ToolStep } from "../../lib/conversation";
import { useT } from "../locale-context";

/** What each lookup is called on the page; an unknown tool shows its own name. */
const TOOL_LABEL: Record<string, string> = {
  find_tasks: "查任务", get_task: "看任务详情", find_milestones: "查里程碑", list_asks: "看待决事项", get_plan: "看日程", list_recent_ops: "看最近操作",
  list_agent_results: "看助手成果", get_forecast: "看完成预测", find_materials: "查文件", list_projects: "看项目", read_material: "读文件",
  get_profile_facts: "查本人情况", list_settings: "看设置", ledger_query: "查总账", get_instructions: "看「给 Crossline 的话」"
};

/**
 * A turn's tool calls, Codex-style: one collapsible row per call — the tool, its arguments and the start of its answer. Open while the
 * turn runs (the rows arrive as the model makes them), folded once it has answered. Reusable for any thread that keeps `ToolStep`s.
 */
export function ToolSteps({ steps, working = false }: { steps: ToolStep[]; working?: boolean }) {
  const t = useT();
  if (!steps.length && !working) return null;
  const names = [...new Set(steps.map((step) => t(TOOL_LABEL[step.tool] ?? step.tool)))];
  return <details className="tool-steps" open={working || undefined} data-working={working ? "" : undefined}>
    <summary>
      {working ? <span role="status">{steps.length ? t("正在处理 · 已查询 {{count}} 次", { count: steps.length }) : t("正在处理…")}</span>
        : <span>{t("查询了 {{count}} 次", { count: steps.length })}</span>}
      {names.length > 0 && <small className="muted">{names.join(" · ")}</small>}
    </summary>
    <ol>{steps.map((step, index) => <li key={`${step.at}-${index}`}>
      <details>
        <summary><b>{t(TOOL_LABEL[step.tool] ?? step.tool)}</b> <code>{step.tool}</code>{step.args && <small className="mono">{step.args}</small>}
          {step.review && <small className="muted">{t("复核")}</small>}</summary>
        <pre className="tool-step-result">{step.result}</pre>
      </details>
    </li>)}</ol>
  </details>;
}
