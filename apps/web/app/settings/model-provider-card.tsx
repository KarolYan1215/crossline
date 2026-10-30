"use client";

import { useEffect, useState } from "react";
import { Tag } from "../ui/tag";
import { useLocale, useT } from "../locale-context";
import { intlLocale, type Translate } from "../../lib/i18n";
import "./model-provider-card.css";
import { SetupGuide } from "../ui/setup-guide";
import { modelProviderGuide } from "../../lib/setup-guides";

type Provider = { id: string; kind: "chat" | "responses" | "siwc-plan"; label: string; baseUrl: string; model: string; responseFormat?: "json_object"; keyLast4: string | null };
type Preset = { id: string; label: string; kind: "chat" | "responses"; baseUrl: string; model: string; responseFormat?: "json_object" };
type Feature = { skill: string; label: string; critical: boolean; served: boolean; reason: string };
export type ProviderView = {
  provider: Provider | null;
  presets: Preset[];
  unavailable: string;
  signedIn: boolean;
  conformance: { ranAt: string; passRate: number; repairRate: number; p95Ms: number; runs: number; current: boolean; failures: Array<{ case: string; code: string }> } | null;
  features: Feature[];
  testing: { done: number; total: number } | null;
  blocker?: { code: string; message: string };
};
type Draft = { id: string; label: string; kind: "chat" | "responses"; baseUrl: string; model: string; json: boolean; apiKey: string };

const KIND_LABEL = { chat: "Chat Completions 兼容接口", responses: "Responses 接口", "siwc-plan": "ChatGPT 套餐共享" } as const;
const draftOf = (source: Preset | Provider): Draft => ({ id: source.id, label: source.label, kind: source.kind === "chat" ? "chat" : "responses",
  baseUrl: source.baseUrl, model: source.model, json: source.responseFormat === "json_object", apiKey: "" });
const percent = (value: number) => `${Math.round(value * 100)}%`;
/** The worker being down or not configured comes back as the supervisor's own English; the page says it in words (copy-style). */
const shown = (blocker: { code: string; message: string }, t: Translate) => /SUPERVISOR|CAPABILITY/.test(blocker.code) ? t("后台服务没有连上，稍后再试。") : blocker.message;

/**
 * Settings → 模型连接 → 其他模型 (R7, decided 2026-10-13). Any model can be added — DeepSeek, Kimi, 通义千问, 智谱 GLM, Claude, Gemini, the
 * OpenAI API, OpenRouter or a model on this computer — and every one runs through the same Codex path. It serves only what it has passed
 * the check for, and the card says plainly what it can never do here. The key is sent once and never shown again (only its last four).
 * An OpenAI-compatible relay (中转站) is its own starting point (2026-10-30), for someone with neither ChatGPT Plus nor an official API:
 * the worker tries one real request before saving, so a wrong address, key, model or balance is said at once.
 */
export function ModelProviderCard({ initial, onReady, local = false }: { initial?: ProviderView; onReady?: (ready: boolean) => void;
  /** Crossline runs on the person's own computer, so a model there (Ollama) can be reached. */
  local?: boolean }) {
  const t = useT();
  const locale = useLocale();
  const [view, setView] = useState<ProviderView | undefined>(initial);
  // The interview is the first thing an account does: once the added model has passed the check for it, the connect page moves on.
  const interviewServed = Boolean(view?.features.some((feature) => feature.skill.endsWith("crossline-onboarding") && feature.served));
  useEffect(() => { if (view) onReady?.(interviewServed); }, [interviewServed, Boolean(view)]);
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const refresh = async () => {
    const answer = await fetch("/api/model/provider", { cache: "no-store" }).then((response) => response.json() as Promise<ProviderView>).catch(() => undefined);
    if (answer?.blocker) setMessage(shown(answer.blocker, t)); else if (answer) setView(answer);
  };
  useEffect(() => { if (!initial) void refresh(); }, []);
  useEffect(() => {
    if (!view?.testing) return;
    const interval = setInterval(() => { void refresh(); }, 5_000);
    return () => clearInterval(interval);
  }, [Boolean(view?.testing)]);

  const call = async (method: "POST" | "DELETE", path: string, body?: unknown) => {
    setBusy(true);
    setMessage(undefined);
    const answer = await fetch(path, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) })
      .then((response) => response.json() as Promise<ProviderView>).catch(() => ({ blocker: { code: "", message: t("后台服务没有连上，稍后再试。") } }) as ProviderView);
    setBusy(false);
    if (answer.blocker) { setMessage(shown(answer.blocker, t)); return false; }
    setView(answer);
    return true;
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!draft) return;
    const ok = await call("POST", "/api/model/provider", { id: draft.id, label: draft.label, kind: draft.kind, baseUrl: draft.baseUrl, model: draft.model,
      ...(draft.apiKey.trim() ? { apiKey: draft.apiKey.trim() } : {}), ...(draft.kind === "chat" && draft.json ? { responseFormat: "json_object" } : {}) });
    if (ok) setDraft(undefined);
  };

  const provider = view?.provider;
  const relayPreset = view?.presets.find((preset) => preset.id === "relay");
  const relay = draft?.id === "relay";
  const served = view?.features.filter((feature) => feature.served) ?? [];
  const withheld = view?.features.filter((feature) => !feature.served) ?? [];
  return <section className="st-card model-provider-card" aria-label={t("其他模型")}>
    <header><h3>{t("其他模型")}</h3><small>{t("保存后先自动检验它的回答格式，只承担检验通过的功能")}</small>
      <Tag tone={view?.testing ? "warn" : provider ? (served.length ? "ok" : "warn") : "neutral"}>
        {view?.testing ? t("检验中") : provider ? (served.length ? t("承担 {{count}} 项", { count: served.length }) : t("未通过检验")) : t("未添加")}</Tag></header>
    {message && <p role="status" className="muted">{message}</p>}
    {provider && !draft && <div className="st-row"><span className="st-row-label">{provider.label}
      <small>{t(KIND_LABEL[provider.kind])} · {provider.baseUrl} · {provider.model} · {provider.keyLast4 ? t("密钥 ···{{last4}}", { last4: provider.keyLast4 }) : t("无需密钥")}</small></span>
      <span className="st-row-actions">
        <button type="button" className="primary-button" disabled={busy || Boolean(view?.testing)} onClick={() => void call("POST", "/api/model/provider/test")}>
          {view?.conformance ? t("重新检验") : t("运行检验")}</button>
        <button type="button" disabled={busy} onClick={() => setDraft(draftOf(provider))}>{t("修改")}</button>
        <button type="button" disabled={busy} onClick={() => void call("DELETE", "/api/model/provider")}>{t("移除")}</button>
      </span></div>}
    {view?.testing && <div className="st-row"><span className="st-row-label">{t("正在检验：每个功能的回答格式各试一次，关键功能试三次")}
      <small>{t("本机模型每项要几分钟；可以离开此页，结果会保存。")}</small></span>
      <meter min={0} max={view.testing.total} value={view.testing.done} aria-label={t("已完成 {{done}} / {{total}}", { done: view.testing.done, total: view.testing.total })} />
      <b>{view.testing.done} / {view.testing.total}</b></div>}
    {!provider && !draft && view && <div className="st-row"><span className="st-row-label">{t("添加一个模型")}
      <small>{t("选一个起点，接口地址和模型名都可以改。")}</small></span>
      <span className="st-row-actions">
        <select aria-label={t("模型起点")} defaultValue="" onChange={(event) => { const preset = view.presets.find((item) => item.id === event.target.value); if (preset) setDraft(draftOf(preset)); }}>
          <option value="" disabled>{t("选择…")}</option>
          {view.presets.map((preset) => <option key={preset.id} value={preset.id}>{t(preset.label)}</option>)}
        </select>
      </span></div>}
    {!provider && !draft && relayPreset && <div className="st-row"><span className="st-row-label">{t("没有 ChatGPT Plus，也没有官方 API")}
      <small>{t("用 OpenAI 兼容的中转站一样能用：填中转站给的 base URL、API key 和模型名，保存前先测一次连接。")}</small></span>
      <span className="st-row-actions"><button type="button" className="secondary-button" onClick={() => setDraft(draftOf(relayPreset))}>{t("用中转站接入")}</button></span></div>}
    {draft && <form className="model-provider-form" onSubmit={(event) => void save(event)}>
      {relay && <p className="model-provider-note">{t("中转站转发 OpenAI 兼容的接口。它能看到发给模型的全部内容（访谈回答、任务、上传文件的正文），请选可信的服务。")}</p>}
      <label>{t("显示名称")}<input value={draft.label} maxLength={40} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
      <label>{t("接口类型")}<select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value === "chat" ? "chat" : "responses" })}>
        <option value="chat">{t(KIND_LABEL.chat)}</option><option value="responses">{t(KIND_LABEL.responses)}</option></select>
        {relay && <small>{t("不确定就选 Chat Completions，绝大多数中转站都支持。")}</small>}</label>
      <label>{t("接口地址")}<input value={draft.baseUrl} inputMode="url" placeholder={relay ? "https://relay.example.com/v1" : undefined}
        onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
        {relay && <small>{t("即 base URL，通常以 /v1 结尾。")}</small>}</label>
      <label>{t("模型")}<input value={draft.model} placeholder={relay ? "gpt-4o-mini" : undefined} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
        {relay && <small>{t("照中转站后台模型列表里的名字填写。")}</small>}</label>
      {draft.kind === "chat" && <label className="model-provider-check"><input type="checkbox" checked={draft.json}
        onChange={(event) => setDraft({ ...draft, json: event.target.checked })} />{t("这个接口只支持 JSON 模式（格式要求写进说明里）")}</label>}
      <label>API key<input type="password" autoComplete="off" value={draft.apiKey} placeholder={provider?.keyLast4 && provider.baseUrl === draft.baseUrl ? t("已保存 ···{{last4}}，留空则不变", { last4: provider.keyLast4 }) : relay ? t("从中转站后台复制的 API key") : t("本机模型可以留空")}
        onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} />
        <small>{t("只交给后台加密保存，不进账本、导出和备份，之后不再显示。")}</small></label>
      <span className="st-row-actions"><button type="submit" className="primary-button" disabled={busy}>{busy ? t("正在测试连接…") : t("测试连接并保存")}</button>
        <button type="button" disabled={busy} onClick={() => setDraft(undefined)}>{t("取消")}</button></span>
    </form>}
    {view?.conformance && <div className="st-row"><span className="st-row-label">{view.conformance.current ? t("检验结果") : t("检验结果（已过期，需要重新检验）")}
      <small>{new Date(view.conformance.ranAt).toLocaleString(intlLocale(locale), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
        {" · "}{t("一次答对或修正后答对 {{pass}} · 需要修正 {{repair}} · 较慢的一次 {{seconds}} 秒", { pass: percent(view.conformance.passRate), repair: percent(view.conformance.repairRate), seconds: Math.round(view.conformance.p95Ms / 1000) })}</small></span></div>}
    {provider && <div className="model-provider-features">
      {served.length > 0 && <div><b>{t("交给它")}</b><ul>{served.map((feature) => <li key={feature.skill}>{t(feature.label)}</li>)}</ul></div>}
      <div><b>{view?.signedIn ? t("仍由 ChatGPT 登录承担") : t("暂不可用")}</b><ul>{withheld.map((feature) =>
        <li key={feature.skill}>{t(feature.label)}<small>{feature.reason}</small></li>)}</ul></div>
    </div>}
    {(!provider || draft) && <SetupGuide guide={modelProviderGuide(local)} selected={draft?.id} />}
    <small className="muted">{view?.unavailable}</small>
  </section>;
}
