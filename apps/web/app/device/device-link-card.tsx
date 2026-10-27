"use client";

import { useEffect, useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { SetupGuide } from "../ui/setup-guide";
import { DEVICE_LINK_GUIDE } from "../../lib/setup-guides";
import { useLocale, useT } from "../locale-context";
import { intlLocale, type Locale, type Translate } from "../../lib/i18n";

type DeviceView = { pending?: number; dead?: number; blocked?: { code: string; at: string }; lastSentAt?: string; lastError?: string; modelNeeded?: number; lastPassAt?: string | null };
type NodeAgentView = { enabled: boolean; status?: { state: string; message?: string; since?: string; account?: { type?: string; email?: string } | null } };
type LinkView = { ok?: boolean; linked?: boolean; url?: string; label?: string; linkedAt?: string; tokenReadable?: boolean; device?: DeviceView; node?: NodeAgentView; code?: string; message?: string };

/** What the node agent's state means here (docs/compute-node.md). */
const nodeWords = (node: NodeAgentView | undefined, t: Translate) => {
  if (!node?.enabled) return t("关闭", { context: "state" });
  switch (node.status?.state) {
    case "ready": return t("已接入：网页版把本账号的模型工作交给这台电脑");
    case "connecting": return t("正在连接");
    case "refused": return t("没有接入：{{why}}，稍后自动重试", { why: node.status.message ?? t("被拒绝") });
    case "waiting": return t("连接断开，稍后重连（{{why}}）", { why: node.status.message ?? "" });
    default: return t("正在启动");
  }
};

const time = (iso: string | null | undefined, locale: Locale) => iso ? new Date(iso).toLocaleString(intlLocale(locale), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "—";

/**
 * This computer as a device of the hosted account (docs/device-mode.md): the link and what waits to be sent, or the form that makes it.
 * Linking restarts the background service into device mode; from then on every other page of this app opens the hosted site.
 */
export function DeviceLinkCard() {
  const t = useT();
  const locale = useLocale();
  const [view, setView] = useState<LinkView | undefined>();
  const [url, setUrl] = useState("https://app.crossline.lol");
  const [token, setToken] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  /** Set while the background service restarts into the other mode: the page says so instead of showing its absence as an error. */
  const [restarting, setRestarting] = useState(false);
  const load = async (): Promise<LinkView> => {
    const response = await fetch("/api/device/link", { cache: "no-store" }).catch(() => undefined);
    const next = response ? await response.json().catch(() => undefined) as LinkView ?? { ok: false } : { ok: false, message: t("后台服务没有响应。") };
    setView(next);
    return next;
  };
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 15_000); return () => clearInterval(timer); }, []);
  /** After a change that restarts the service: asked every 2 s until it answers in the state the change leads to (a minute and a half at most). */
  const untilRestarted = async (done: (next: LinkView) => boolean) => {
    setRestarting(true);
    for (let tries = 0; tries < 45; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const next = await load();
      if (next.ok !== false && done(next)) { setRestarting(false); return; }
    }
    setRestarting(false);
    setNote(t("后台服务一分半钟内没有回来：请重新启动电脑上的 Crossline。"));
  };
  const link = async () => {
    setBusy(true); setNote("");
    const response = await fetch("/api/device/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, token }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as LinkView | undefined;
    setBusy(false);
    if (!response?.ok || !body?.ok) { setNote(body?.message ?? t("没有连上，请重试。")); return; }
    setToken("");
    setNote(t("已连接。"));
    void untilRestarted((next) => next.linked === true);
  };
  const unlink = async () => {
    setBusy(true);
    const response = await fetch("/api/device/link", { method: "DELETE" }).catch(() => undefined);
    setBusy(false);
    setNote(response?.ok ? t("已断开。") : t("没有断开，请重试。"));
    if (response?.ok) void untilRestarted((next) => next.linked === false);
  };
  const signInWithKey = async () => {
    setBusy(true);
    const response = await fetch("/api/device/node", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ apiKey }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; message?: string } | undefined;
    setBusy(false);
    setApiKey("");
    setNote(body?.ok ? t("已用 API key 登录这台电脑的 Codex。") : body?.message ?? t("没有登录，请重试。"));
    void load();
  };
  const switchNode = async (enabled: boolean) => {
    setBusy(true);
    const response = await fetch("/api/device/node", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }).catch(() => undefined);
    setBusy(false);
    setNote(response?.ok ? (enabled ? t("已开启。") : t("已关闭。")) : t("没有保存，请重试。"));
    if (response?.ok) void untilRestarted((next) => next.node?.enabled === enabled);
  };
  const device = view?.device;
  return <section className="st-card" aria-label={t("设备连接")}>
    <header><h3>{t("设备连接")}</h3><small>{t("连接后，这台电脑只读本机的屏幕活动、文件夹和录音，结果立即发到网页版；计划、任务和所有模型工作只在网页版进行")}</small></header>
    {view?.linked ? <>
      <div className="st-row"><span className="st-row-label">{t("网页版")}<small>{view.label ? t("本机名称 {{label}}，{{when}} 连接", { label: view.label, when: time(view.linkedAt, locale) }) : t("{{when}} 连接", { when: time(view.linkedAt, locale) })}</small></span><a href={view.url}><b>{view.url}</b></a></div>
      {view.tokenReadable === false && <p className="st-note" role="alert">{t("读不到保存的令牌：在网页版重新生成一个，先断开再连接。")}</p>}
      {device?.blocked && <p className="st-note" role="alert">{t("网页版拒绝了发送（{{code}}）：令牌可能已撤销。在网页版「这台电脑」重新生成令牌，先断开再连接。", { code: device.blocked.code })}</p>}
      <div className="st-row"><span className="st-row-label">{t("发送")}<small>{device?.dead ? t("待发送 {{count}} 件，{{dead}} 件被拒收（不再重试）", { count: device?.pending ?? 0, dead: device.dead }) : t("待发送 {{count}} 件", { count: device?.pending ?? 0 })}</small></span>
        <span className="muted">{t("上次送达 {{when}}", { when: time(device?.lastSentAt, locale) })}</span></div>
      {device?.lastError && !device.blocked && <p className="st-note">{t("上次发送没有成功（{{error}}），会自动重试。", { error: device.lastError })}</p>}
      {Boolean(device?.modelNeeded) && <p className="st-note">{t("有 {{count}} 个录音等着转写：先在下方「录音自动转写」同意下载语音识别模型。", { count: device?.modelNeeded })}</p>}
      <div className="st-row"><span className="st-row-label">{t("作为算力节点")}<small>{t("{{state}}。网页版「这台电脑」也要开启；开机期间这台电脑用本机的 Codex 替网页版跑本账号的模型工作，关机时自动回到服务器", { state: nodeWords(view.node, t) })}</small></span>
        <SegmentedControl label={t("作为算力节点")} value={view.node?.enabled ? "on" : "off"} options={[{ value: "off", label: t("关闭", { context: "state" }) }, { value: "on", label: t("开启", { context: "state" }) }]}
          onChange={(next) => void switchNode(next === "on")} /></div>
      {view.node?.enabled && <div className="st-row"><span className="st-row-label">{t("节点的 Codex 登录")}<small>{view.node.status?.account
        ? view.node.status.account.type === "apiKey" ? t("已用 API key 登录") : t("已登录 {{email}}", { email: view.node.status.account.email ?? "" })
        : t("用这台电脑的 Codex 登录；也可以填 OpenAI API key（按用量计费，key 只存在这台电脑的 Codex 里）")}</small></span>
        <span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-…" autoComplete="off" spellCheck={false}
          style={{ width: "14em" }} />{" "}
          <button type="button" className="secondary-button" disabled={busy || !apiKey.trim()} onClick={() => void signInWithKey()}>{t("用 API key 登录")}</button></span></div>}
      <div className="st-row"><span className="st-row-label">{t("断开")}<small>{t("回到完整模式：本机重新自己做计划和模型工作")}</small></span>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void unlink()}>{t("断开")}</button></div>
    </> : <>
      <label className="st-row"><span className="st-row-label">{t("网页版地址")}</span>
        <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} autoComplete="off" spellCheck={false} /></label>
      <label className="st-row"><span className="st-row-label">{t("设备令牌")}<small>{t("网页版 设置 → 通用 →「这台电脑」生成")}</small></span>
        <input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false} /></label>
      <div className="st-row"><span className="st-row-label" />
        <button type="button" className="primary-button" disabled={busy || !token.trim() || !url.trim()} onClick={() => void link()}>{busy ? t("正在连接…") : t("连接")}</button></div>
      {view && view.ok === false && !restarting && <p className="st-note">{view.message ?? t("后台服务没有响应。")}</p>}
      <SetupGuide guide={DEVICE_LINK_GUIDE} />
    </>}
    {restarting && <p role="status" className="st-note">{t("后台服务正在重启（换模式），几秒后这里刷新……")}</p>}
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}

/** 作息记录 and 键鼠节律 on this computer: the same switches the settings page has, here because every other page now opens the hosted site. */
export function DeviceSignals({ sleep, rhythm }: { sleep: boolean; rhythm: boolean }) {
  const t = useT();
  const [values, setValues] = useState({ sleep, rhythm });
  const [note, setNote] = useState("");
  const change = async (key: "sleep" | "rhythm", on: boolean) => {
    setValues((current) => ({ ...current, [key]: on }));
    const response = key === "sleep"
      ? await fetch("/api/settings/sleep-tracking", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) }).catch(() => undefined)
      : await fetch("/api/settings/energy-signals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signal: "input_rhythm", on }) }).catch(() => undefined);
    if (!response?.ok) { setValues((current) => ({ ...current, [key]: !on })); setNote(t("未保存，请重试")); } else setNote(on ? t("已开启") : t("已关闭，已删除记录（网页版的也会删除）"));
  };
  const options = [{ value: "off", label: t("关闭", { context: "state" }) }, { value: "on", label: t("开启", { context: "state" }) }] as const;
  return <section className="st-card" aria-label={t("作息与键鼠节律")}>
    <header><h3>{t("作息与键鼠节律")}</h3><small>{t("只记长时间空闲的起止和每刻钟的输入秒数，不记按了哪个键、窗口是什么")}</small></header>
    <div className="st-row"><span className="st-row-label">{t("作息记录")}<small>{t("四小时以上无操作的起止，用于推算睡眠")}</small></span>
      <SegmentedControl label={t("作息记录")} value={values.sleep ? "on" : "off"} options={options} onChange={(next) => void change("sleep", next === "on")} /></div>
    <div className="st-row"><span className="st-row-label">{t("键鼠节律")}<small>{t("每刻钟的输入秒数、停顿和指针移动距离")}</small></span>
      <SegmentedControl label={t("键鼠节律")} value={values.rhythm ? "on" : "off"} options={options} onChange={(next) => void change("rhythm", next === "on")} /></div>
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}
