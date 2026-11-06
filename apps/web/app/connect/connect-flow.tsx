"use client";

import { useCallback, useEffect, useState } from "react";
import { CodexAccountControl } from "../connectors/codex-account-control";
import { useT } from "../locale-context";
import { ModelProviderCard } from "../settings/model-provider-card";
import { FirstHint } from "../ui/first-hint";
import { InvitePanel } from "./invite-panel";
import { NodeSetupSteps } from "./node-setup";

/** How long the first reads may take before the choices are shown anyway (a read that fails never answers). */
export const CHECK_MS = 6_000;
/** How long the next page may take to open before the page offers a link to it (the hosted server queues page renders). */
export const SLOW_MS = 5_000;

export type ConnectPhase = "checking" | "choose" | "entering";

/**
 * What the page shows (W-233, 2026-11-05): while the first reads are out, a waiting line instead of every way to connect — an account
 * that already had a model looked at the choices for seconds and thought it was being asked again; once any way works, the waiting
 * line again, never the choices, until the next page opens.
 */
export function connectPhase({ chatgpt, api, connected, patient }: { chatgpt: boolean | undefined; api: boolean | undefined; connected: boolean; patient: boolean }): ConnectPhase {
  if (connected) return "entering";
  return !patient && (chatgpt === undefined || api === undefined) ? "checking" : "choose";
}

/**
 * Connects a model, then moves on by itself; an account already connected never sees this page for more than a moment. Either path
 * counts (the owner's decision of 2026-10-17): the person's own ChatGPT, or another model's API that has passed the check for the
 * interview. Both controls are always mounted, hidden while the page waits: they are what read the connection, so rendering them only
 * once the answer is known left the page waiting forever.
 */
export function ConnectFlow({ next, hosted = false }: { next: string;
  /** The hosted server signs no guest's ChatGPT in (2026-11-05): the person's own computer as a node, another model's API, or an invite. */
  hosted?: boolean }) {
  const t = useT();
  const [chatgpt, setChatgpt] = useState<boolean>();
  const [api, setApi] = useState<boolean>();
  const [invited, setInvited] = useState(false);
  const [node, setNode] = useState(false);
  const [patient, setPatient] = useState(false);
  const [slow, setSlow] = useState(false);
  const connected = Boolean(chatgpt || api || invited || node);
  const phase = connectPhase({ chatgpt, api, connected, patient });
  const sponsored = useCallback(() => setInvited(true), []);
  useEffect(() => { const timer = setTimeout(() => setPatient(true), CHECK_MS); return () => clearTimeout(timer); }, []);
  useEffect(() => {
    if (!connected) return;
    location.replace(next);
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [connected, next]);
  return <div className="connect-flow">
    {phase !== "choose" && <ConnectWaiting phase={phase} next={next} slow={slow} />}
    <div className="connect-options" hidden={phase !== "choose"}>
      <p>{t("访谈、画像报告和每周的排程都由本人连接的 AI 模型来做：本人的 ChatGPT 账号，或者本人的模型 API key。连接一次即可，之后不用再管。")}</p>
      <FirstHint id="connect" title={t("不确定选哪种？")}>
        {hosted ? t("有 ChatGPT 账号就在自己电脑上开启算力节点：在那台电脑上登录 ChatGPT，模型就在那台电脑上用这个账号自己的额度运行，不另收费。")
          : t("有 ChatGPT 账号就选上面的「用一次性代码连接」：按三步做完约 1 分钟，用的是这个 ChatGPT 账号自己的额度，不另收费。")}{" "}
        {t("没有 ChatGPT 账号、但有 DeepSeek、Kimi 等的 API key，就用下面的「其他模型」；它要先自动检验 10–20 分钟，期间可以离开此页。")}{" "}
        {t("ChatGPT Plus 和官方 API 都没有，也可以用 OpenAI 兼容的中转站：在「其他模型」里点「用中转站接入」，填中转站给的 base URL 和 API key。")}
      </FirstHint>
      <CodexAccountControl onConnected={setChatgpt} />
      {hosted && <NodeSetupSteps onReady={setNode} />}
      <h2 className="connect-or">{t("或者用其他模型的 API")}</h2>
      <p className="muted">{t("DeepSeek、Kimi、通义千问、智谱 GLM、OpenAI API、OpenRouter，或 OpenAI 兼容的中转站。保存前先测一次连接，之后自动检验回答格式，约 10–20 分钟；访谈一项通过就进入访谈，网页搜索和画形象这类功能仍要 ChatGPT 账号。")}</p>
      <ModelProviderCard onReady={setApi} />
      <h2 className="connect-or">{t("没有 ChatGPT Plus，也没有 API key")}</h2>
      <InvitePanel onRedeemed={sponsored} onSponsored={sponsored}
        lead={t("ChatGPT 免费账号的额度通常做不完访谈。可以申请用开发者提供的模型，通过后用邀请码完成访谈和日常使用。")} />
      <p className="muted">{t("连接后自动进入访谈。")}</p>
    </div>
  </div>;
}

/** The waiting line: what is happening, and — when the next page is slow to open — a link to it, so nobody is left before a still page. */
export function ConnectWaiting({ phase, next, slow }: { phase: Exclude<ConnectPhase, "choose">; next: string; slow: boolean }) {
  const t = useT();
  const interview = next.startsWith("/onboarding");
  return <div className="connect-wait" role="status" aria-live="polite">
    <span className="connect-spinner" aria-hidden="true" />
    <div>
      <p>{phase === "checking" ? t("正在检查这个账号的模型连接…") : interview ? t("已连接，正在进入访谈…") : t("已连接，正在打开…")}</p>
      {phase === "entering" && slow && <p className="muted">{t("服务器较忙，页面还在打开。")} <a href={next}>{interview ? t("直接进入访谈") : t("直接打开")}</a></p>}
    </div>
  </div>;
}
