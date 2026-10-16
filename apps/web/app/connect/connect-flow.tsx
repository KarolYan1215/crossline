"use client";

import { useEffect, useState } from "react";
import { CodexAccountControl } from "../connectors/codex-account-control";

/** Connects the model, then moves on by itself; an account already connected never sees this page for more than a moment. */
export function ConnectFlow({ next }: { next: string }) {
  const [connected, setConnected] = useState<boolean>();
  useEffect(() => { if (connected) location.replace(next); }, [connected, next]);
  if (connected !== false) return <p className="muted" role="status">{connected ? "已连接，正在进入…" : "正在检查连接…"}</p>;
  return <div className="connect-flow">
    <p>和 AI 的深度访谈、跨人生主线报告和跨主线排程计划，都用本人的 ChatGPT 额度运行。连接一次即可，约 1 分钟。</p>
    <CodexAccountControl onConnected={setConnected} />
    <p className="muted">连接后自动进入访谈。</p>
  </div>;
}
