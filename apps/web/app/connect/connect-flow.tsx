"use client";

import { useCallback, useEffect, useState } from "react";
import { CodexAccountControl } from "../connectors/codex-account-control";
import { useT } from "../locale-context";
import { ModelProviderCard } from "../settings/model-provider-card";
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

/** The ways to connect, in the order offered: the person's ChatGPT is the quickest, so it comes first and is chosen to begin with. */
export type ConnectWay = "chatgpt" | "api" | "node";

/**
 * Connects a model, then moves on by itself; an account already connected never sees this page for more than a moment. Any way counts
 * (the owner's decisions of 2026-10-17 and 2026-11-06): the person's own ChatGPT — on the hosted site too, since Crossline is free and open
 * source —, another model's API that has passed the check for the interview, the person's own computer as a node, or an invite. The page
 * asks first which way (2026-11-06: every way's steps one under another read as one long tutorial), then shows only that one's steps.
 * Every control stays mounted, hidden while not chosen or while the page waits: they are what read the connection, so rendering them only
 * once the answer is known left the page waiting forever.
 */
export function ConnectFlow({ next, hosted = false }: { next: string;
  /** The hosted site: the person's own computer can also run the model, as a node. */
  hosted?: boolean }) {
  const t = useT();
  const [chatgpt, setChatgpt] = useState<boolean>();
  const [api, setApi] = useState<boolean>();
  const [invited, setInvited] = useState(false);
  const [node, setNode] = useState(false);
  const [patient, setPatient] = useState(false);
  const [slow, setSlow] = useState(false);
  const [way, setWay] = useState<ConnectWay>("chatgpt");
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
  const ways: Array<{ id: ConnectWay; title: string; detail: string; meta: string }> = [
    { id: "chatgpt", title: t("ChatGPT 账号"), detail: t("用本人 ChatGPT 账号的额度，不另收费；网页搜索、画图等功能都能用"), meta: t("推荐 · 约 1 分钟") },
    { id: "api", title: t("其他模型的 API key"), detail: t("DeepSeek、Kimi、通义千问、智谱、OpenAI API、OpenRouter 或中转站"), meta: t("保存后自动检验约 10–20 分钟") },
    ...(hosted ? [{ id: "node" as const, title: t("本人电脑当算力节点"), detail: t("在自己的 Windows 电脑上装「Crossline 节点」，模型在那台电脑上运行"), meta: t("约 5 分钟 · 电脑需开机") }] : [])
  ];
  return <div className="connect-flow">
    {phase !== "choose" && <ConnectWaiting phase={phase} next={next} slow={slow} />}
    <div className="connect-options" hidden={phase !== "choose"}>
      <p>{t("访谈、画像报告和每周的排程都由本人连接的 AI 模型来做。选一种方式连接，一次即可，之后不用再管。")}</p>
      <div className="connect-ways" role="radiogroup" aria-label={t("连接方式")}>
        {ways.map((item, index) => <button key={item.id} type="button" role="radio" aria-checked={way === item.id} className="connect-way" onClick={() => setWay(item.id)}>
          <span className="connect-way-mark" aria-hidden="true">{index + 1}</span>
          <span className="connect-way-text"><b>{item.title}</b><small>{item.detail}</small><em>{item.meta}</em></span>
        </button>)}
      </div>
      <div className="connect-panel" hidden={way !== "chatgpt"}><CodexAccountControl onConnected={setChatgpt} /></div>
      <div className="connect-panel" hidden={way !== "api"}>
        <p className="muted">{t("保存前先测一次连接，之后自动检验回答格式，约 10–20 分钟，期间可以离开此页；访谈一项通过就进入访谈。网页搜索和画形象这类功能仍要 ChatGPT 账号。")}</p>
        <ModelProviderCard onReady={setApi} />
      </div>
      {hosted && <div className="connect-panel" hidden={way !== "node"}><NodeSetupSteps onReady={setNode} /></div>}
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
