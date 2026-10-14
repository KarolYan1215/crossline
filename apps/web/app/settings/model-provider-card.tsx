"use client";

import { useEffect, useState } from "react";
import { Tag } from "../ui/tag";
import "./model-provider-card.css";

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

/**
 * Settings → 模型连接 → 其他模型 (R7, decided 2026-10-13). Any model can be added — DeepSeek, Kimi, 通义千问, 智谱 GLM, Claude, Gemini, the
 * OpenAI API, OpenRouter or a model on this computer — and every one runs through the same Codex path. It serves only what it has passed
 * the check for, and the card says plainly what it can never do here. The key is sent once and never shown again (only its last four).
 */
export function ModelProviderCard({ initial }: { initial?: ProviderView }) {
  const [view, setView] = useState<ProviderView | undefined>(initial);
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const refresh = async () => {
    const answer = await fetch("/api/model/provider", { cache: "no-store" }).then((response) => response.json() as Promise<ProviderView>).catch(() => undefined);
    if (answer?.blocker) setMessage(answer.blocker.message); else if (answer) setView(answer);
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
      .then((response) => response.json() as Promise<ProviderView>).catch(() => ({ blocker: { code: "", message: "后台服务没有连上，稍后再试。" } }) as ProviderView);
    setBusy(false);
    if (answer.blocker) { setMessage(answer.blocker.message); return false; }
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
  const served = view?.features.filter((feature) => feature.served) ?? [];
  const withheld = view?.features.filter((feature) => !feature.served) ?? [];
  return <section className="st-card model-provider-card" aria-label="其他模型">
    <header><h3>其他模型</h3><small>经同一条 Codex 路径运行，只承担检验通过的功能</small>
      <Tag tone={view?.testing ? "warn" : provider ? (served.length ? "ok" : "warn") : "neutral"}>
        {view?.testing ? "检验中" : provider ? (served.length ? `承担 ${served.length} 项` : "未通过检验") : "未添加"}</Tag></header>
    {message && <p role="status" className="muted">{message}</p>}
    {provider && !draft && <div className="st-row"><span className="st-row-label">{provider.label}
      <small>{KIND_LABEL[provider.kind]} · {provider.baseUrl} · {provider.model}{provider.keyLast4 ? ` · 密钥 ···${provider.keyLast4}` : " · 无需密钥"}</small></span>
      <span className="st-row-actions">
        <button type="button" className="primary-button" disabled={busy || Boolean(view?.testing)} onClick={() => void call("POST", "/api/model/provider/test")}>
          {view?.conformance ? "重新检验" : "运行检验"}</button>
        <button type="button" disabled={busy} onClick={() => setDraft(draftOf(provider))}>修改</button>
        <button type="button" disabled={busy} onClick={() => void call("DELETE", "/api/model/provider")}>移除</button>
      </span></div>}
    {view?.testing && <div className="st-row"><span className="st-row-label">正在检验：每个功能的回答格式各试一次，关键功能试三次
      <small>本机模型每项要几分钟；可以离开此页，结果会保存。</small></span>
      <meter min={0} max={view.testing.total} value={view.testing.done} aria-label={`已完成 ${view.testing.done} / ${view.testing.total}`} />
      <b>{view.testing.done} / {view.testing.total}</b></div>}
    {!provider && !draft && view && <div className="st-row"><span className="st-row-label">添加一个模型
      <small>选一个起点，接口地址和模型名都可以改。</small></span>
      <span className="st-row-actions">
        <select aria-label="模型起点" defaultValue="" onChange={(event) => { const preset = view.presets.find((item) => item.id === event.target.value); if (preset) setDraft(draftOf(preset)); }}>
          <option value="" disabled>选择…</option>
          {view.presets.map((preset) => <option key={preset.id} value={preset.id}>{preset.label}</option>)}
        </select>
      </span></div>}
    {draft && <form className="model-provider-form" onSubmit={(event) => void save(event)}>
      <label>显示名称<input value={draft.label} maxLength={40} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
      <label>接口类型<select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value === "chat" ? "chat" : "responses" })}>
        <option value="chat">{KIND_LABEL.chat}</option><option value="responses">{KIND_LABEL.responses}</option></select></label>
      <label>接口地址<input value={draft.baseUrl} inputMode="url" onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} /></label>
      <label>模型<input value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} /></label>
      {draft.kind === "chat" && <label className="model-provider-check"><input type="checkbox" checked={draft.json}
        onChange={(event) => setDraft({ ...draft, json: event.target.checked })} />这个接口只支持 JSON 模式（格式要求写进说明里）</label>}
      <label>API key<input type="password" autoComplete="off" value={draft.apiKey} placeholder={provider?.keyLast4 && provider.baseUrl === draft.baseUrl ? `已保存 ···${provider.keyLast4}，留空则不变` : "本机模型可以留空"}
        onChange={(event) => setDraft({ ...draft, apiKey: event.target.value })} />
        <small>只交给后台加密保存在这台电脑上，不进账本、导出和备份，之后不再显示。</small></label>
      <span className="st-row-actions"><button type="submit" className="primary-button" disabled={busy}>保存</button>
        <button type="button" disabled={busy} onClick={() => setDraft(undefined)}>取消</button></span>
    </form>}
    {view?.conformance && <div className="st-row"><span className="st-row-label">检验结果{view.conformance.current ? "" : "（已过期，需要重新检验）"}
      <small>{new Date(view.conformance.ranAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}
        {` · 一次答对或修正后答对 ${percent(view.conformance.passRate)} · 需要修正 ${percent(view.conformance.repairRate)} · 较慢的一次 ${Math.round(view.conformance.p95Ms / 1000)} 秒`}</small></span></div>}
    {provider && <div className="model-provider-features">
      {served.length > 0 && <div><b>交给它</b><ul>{served.map((feature) => <li key={feature.skill}>{feature.label}</li>)}</ul></div>}
      <div><b>{view?.signedIn ? "仍由 ChatGPT 登录承担" : "暂不可用"}</b><ul>{withheld.map((feature) =>
        <li key={feature.skill}>{feature.label}<small>{feature.reason}</small></li>)}</ul></div>
    </div>}
    <small className="muted">{view?.unavailable}</small>
  </section>;
}
