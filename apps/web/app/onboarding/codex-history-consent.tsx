"use client";
import { useState } from "react";

export type HistorySource = { label: string; excerpt: string };

/**
 * A one-click, no-standing-setting gate on reading the person's own day-to-day Codex CLI session history
 * (`~/.codex/sessions`, or wherever `CROSSLINE_PERSONAL_CODEX_HOME` points) — a completely different,
 * personal directory from the worker's own isolated Codex sandbox that never touches it. Every click reads
 * fresh; there is nothing to revoke later because nothing is remembered once this page is left. Filtering
 * (dropping near-empty sessions, extracting only a short excerpt) happens locally on the machine before
 * anything is handed to the onboarding conversation — see `apps/worker/src/codex-history.ts`.
 */
export function CodexHistoryConsent({ onScanned }: { onScanned: (sources: HistorySource[], summary: string) => void }) {
  const [state, setState] = useState<"unasked" | "scanning" | "done" | "declined" | "error">("unasked");
  const [summary, setSummary] = useState("");

  const scan = async () => {
    setState("scanning");
    try {
      const response = await fetch("/api/onboarding/codex-history", { method: "POST" });
      const result = await response.json().catch(() => ({})) as
        { sessionCount?: number; keptCount?: number; sources?: HistorySource[]; blocker?: { message?: string } };
      if (!response.ok || !result.sources) {
        setSummary(result.blocker?.message ?? "读取失败，可能是本机没有安装 Codex CLI，或从未使用过。");
        setState("error");
        return;
      }
      const text = `已读取 ${result.sessionCount ?? 0} 个会话，其中 ${result.keptCount ?? 0} 个有实质内容，将作为背景提供给访谈（只是每个会话开头的一小段摘要，不是完整对话）。`;
      setSummary(text);
      setState("done");
      onScanned(result.sources, text);
    } catch {
      setSummary("网络或本机 worker 不可用，跳过本地历史。");
      setState("error");
    }
  };

  return <div className="consent-ask" role="region" aria-label="本地 Codex CLI 历史记录授权">
    <p><b>要不要读取本机 Codex CLI 的历史会话，帮助分析你的真实业务方向？</b></p>
    <p>会读取 <code>~/.codex/sessions</code> 下的会话文件（与 Crossline worker 自己的 Codex 沙箱完全无关，那个不会被读取）。
      本机先按内容长度过滤掉过短的会话，对留下的每个会话只截取开头一小段摘要——
      <b>不会把完整对话发送出去</b>，摘要只会在这次访谈里作为背景提供给分析模型。</p>
    {state === "unasked" && <div>
      <button type="button" className="secondary-button" onClick={() => void scan()}>读取并分析（可选）</button>
      <button type="button" onClick={() => setState("declined")}>跳过，只用下面的问卷回答</button>
    </div>}
    {state === "scanning" && <p role="status">正在读取本机历史…</p>}
    {(state === "done" || state === "error") && <p role="status">{summary}</p>}
    {state === "declined" && <p role="status">已跳过，访谈只会依据你填写的问卷回答。</p>}
  </div>;
}
