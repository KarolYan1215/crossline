"use client";

import { useEffect, useState } from "react";
import { CodexAccountControl } from "../connectors/codex-account-control";
import { ModelProviderCard } from "../settings/model-provider-card";
import { FirstHint } from "../ui/first-hint";

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
    <p>访谈、画像报告和每周的排程都由本人连接的 AI 模型来做：本人的 ChatGPT 账号，或者本人的模型 API key。连接一次即可，之后不用再管。</p>
    <FirstHint id="connect" title="不确定选哪种？">
      有 ChatGPT 账号就选上面的「用一次性代码连接」：按三步做完约 1 分钟，用的是这个 ChatGPT 账号自己的额度，不另收费。
      没有 ChatGPT 账号、但有 DeepSeek、Kimi 等的 API key，就用下面的「其他模型」；它要先自动检验 10–20 分钟，期间可以离开此页。
    </FirstHint>
    <CodexAccountControl onConnected={setChatgpt} />
    <h2 className="connect-or">或者用其他模型的 API</h2>
    <p className="muted">DeepSeek、Kimi、通义千问、智谱 GLM、OpenAI API、OpenRouter 等。保存后自动检验回答格式，约 10–20 分钟；访谈一项通过就进入访谈，网页搜索和画形象这类功能仍要 ChatGPT 账号。</p>
    <ModelProviderCard onReady={setApi} />
    <p className="muted" role="status">{connected ? "已连接，正在进入访谈…" : "连接后自动进入访谈。"}</p>
  </div>;
}
