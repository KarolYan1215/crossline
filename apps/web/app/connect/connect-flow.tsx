"use client";

import { useEffect, useState } from "react";
import { CodexAccountControl } from "../connectors/codex-account-control";
import { ModelProviderCard } from "../settings/model-provider-card";

/**
 * Connects a model, then moves on by itself; an account already connected never sees this page for more than a moment. Either path
 * counts (the owner's decision of 2026-10-17): the person's own ChatGPT, or another model's API that has passed the check for the
 * interview. Both controls are always mounted: they are what read the connection, so rendering them only once the answer is known left
 * the page waiting forever.
 */
export function ConnectFlow({ next }: { next: string }) {
  const [chatgpt, setChatgpt] = useState<boolean>();
  const [api, setApi] = useState<boolean>();
  const connected = Boolean(chatgpt || api);
  useEffect(() => { if (connected) location.replace(next); }, [connected, next]);
  return <div className="connect-flow">
    <p>和 AI 的深度访谈、跨人生主线报告和跨主线排程计划，都在本人连接的模型上运行：本人的 ChatGPT 账号，或者自己的模型 API。连接一次即可。</p>
    <CodexAccountControl onConnected={setChatgpt} />
    <h2 className="connect-or">或者用其他模型的 API</h2>
    <p className="muted">DeepSeek、Kimi、通义千问、智谱 GLM、OpenAI API、OpenRouter 等。保存后自动检验回答格式，约 10–20 分钟；访谈一项通过就进入访谈，网页搜索和画形象这类功能仍要 ChatGPT 账号。</p>
    <ModelProviderCard onReady={setApi} />
    <p className="muted" role="status">{connected ? "已连接，正在进入访谈…" : "连接后自动进入访谈。"}</p>
  </div>;
}
