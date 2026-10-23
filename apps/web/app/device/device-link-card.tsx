"use client";

import { useEffect, useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { SetupGuide } from "../ui/setup-guide";
import { DEVICE_LINK_GUIDE } from "../../lib/setup-guides";

type DeviceView = { pending?: number; dead?: number; blocked?: { code: string; at: string }; lastSentAt?: string; lastError?: string; modelNeeded?: number; lastPassAt?: string | null };
type NodeAgentView = { enabled: boolean; status?: { state: string; message?: string; since?: string } };
type LinkView = { ok?: boolean; linked?: boolean; url?: string; label?: string; linkedAt?: string; tokenReadable?: boolean; device?: DeviceView; node?: NodeAgentView; code?: string; message?: string };

/** What the node agent's state means here (docs/compute-node.md). */
const nodeWords = (node: NodeAgentView | undefined) => {
  if (!node?.enabled) return "关闭";
  switch (node.status?.state) {
    case "ready": return "已接入：网页版把本账号的模型工作交给这台电脑";
    case "connecting": return "正在连接";
    case "refused": return `没有接入：${node.status.message ?? "被拒绝"}，稍后自动重试`;
    case "waiting": return `连接断开，稍后重连（${node.status.message ?? ""}）`;
    default: return "正在启动";
  }
};

const time = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

/**
 * This computer as a device of the hosted account (docs/device-mode.md): the link and what waits to be sent, or the form that makes it.
 * Linking restarts the background service into device mode; from then on every other page of this app opens the hosted site.
 */
export function DeviceLinkCard() {
  const [view, setView] = useState<LinkView | undefined>();
  const [url, setUrl] = useState("https://app.crossline.lol");
  const [token, setToken] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async () => {
    const response = await fetch("/api/device/link", { cache: "no-store" }).catch(() => undefined);
    setView(response ? await response.json().catch(() => undefined) as LinkView : { ok: false, message: "后台服务没有响应。" });
  };
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 15_000); return () => clearInterval(timer); }, []);
  const link = async () => {
    setBusy(true); setNote("");
    const response = await fetch("/api/device/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, token }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as LinkView | undefined;
    setBusy(false);
    if (!response?.ok || !body?.ok) { setNote(body?.message ?? "没有连上，请重试。"); return; }
    setToken("");
    setNote("已连接。后台服务正在以设备模式重启，几秒后这里显示发送情况。");
    setTimeout(() => void load(), 6_000);
  };
  const unlink = async () => {
    setBusy(true);
    const response = await fetch("/api/device/link", { method: "DELETE" }).catch(() => undefined);
    setBusy(false);
    setNote(response?.ok ? "已断开。后台服务正在以完整模式重启。" : "没有断开，请重试。");
    setTimeout(() => void load(), 6_000);
  };
  const switchNode = async (enabled: boolean) => {
    setBusy(true);
    const response = await fetch("/api/device/node", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) }).catch(() => undefined);
    setBusy(false);
    setNote(response?.ok ? (enabled ? "已开启。后台服务正在重启，几秒后连上网页版。" : "已关闭。后台服务正在重启。") : "没有保存，请重试。");
    setTimeout(() => void load(), 6_000);
  };
  const device = view?.device;
  return <section className="st-card" aria-label="设备连接">
    <header><h3>设备连接</h3><small>连接后，这台电脑只读本机的屏幕活动、文件夹和录音，结果立即发到网页版；计划、任务和所有模型工作只在网页版进行</small></header>
    {view?.linked ? <>
      <div className="st-row"><span className="st-row-label">网页版<small>{view.label ? `本机名称 ${view.label}，` : ""}{time(view.linkedAt)} 连接</small></span><a href={view.url}><b>{view.url}</b></a></div>
      {view.tokenReadable === false && <p className="st-note" role="alert">读不到保存的令牌：在网页版重新生成一个，先断开再连接。</p>}
      {device?.blocked && <p className="st-note" role="alert">网页版拒绝了发送（{device.blocked.code}）：令牌可能已撤销。在网页版「这台电脑」重新生成令牌，先断开再连接。</p>}
      <div className="st-row"><span className="st-row-label">发送<small>{`待发送 ${device?.pending ?? 0} 件${device?.dead ? `，${device.dead} 件被拒收（不再重试）` : ""}`}</small></span>
        <span className="muted">上次送达 {time(device?.lastSentAt)}</span></div>
      {device?.lastError && !device.blocked && <p className="st-note">上次发送没有成功（{device.lastError}），会自动重试。</p>}
      {Boolean(device?.modelNeeded) && <p className="st-note">有 {device?.modelNeeded} 个录音等着转写：先在下方「录音自动转写」同意下载语音识别模型。</p>}
      <div className="st-row"><span className="st-row-label">作为算力节点<small>{nodeWords(view.node)}。网页版「这台电脑」也要开启；开机期间这台电脑用本机的 Codex 替网页版跑本账号的模型工作，关机时自动回到服务器</small></span>
        <SegmentedControl label="作为算力节点" value={view.node?.enabled ? "on" : "off"} options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]}
          onChange={(next) => void switchNode(next === "on")} /></div>
      <div className="st-row"><span className="st-row-label">断开<small>回到完整模式：本机重新自己做计划和模型工作</small></span>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void unlink()}>断开</button></div>
    </> : <>
      <label className="st-row"><span className="st-row-label">网页版地址</span>
        <input type="url" value={url} onChange={(event) => setUrl(event.target.value)} autoComplete="off" spellCheck={false} /></label>
      <label className="st-row"><span className="st-row-label">设备令牌<small>网页版 设置 → 通用 →「这台电脑」生成</small></span>
        <input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false} /></label>
      <div className="st-row"><span className="st-row-label" />
        <button type="button" className="primary-button" disabled={busy || !token.trim() || !url.trim()} onClick={() => void link()}>{busy ? "正在连接…" : "连接"}</button></div>
      {view && view.ok === false && <p className="st-note">{view.message ?? "后台服务没有响应。"}</p>}
      <SetupGuide guide={DEVICE_LINK_GUIDE} />
    </>}
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}

/** 作息记录 and 键鼠节律 on this computer: the same switches the settings page has, here because every other page now opens the hosted site. */
export function DeviceSignals({ sleep, rhythm }: { sleep: boolean; rhythm: boolean }) {
  const [values, setValues] = useState({ sleep, rhythm });
  const [note, setNote] = useState("");
  const change = async (key: "sleep" | "rhythm", on: boolean) => {
    setValues((current) => ({ ...current, [key]: on }));
    const response = key === "sleep"
      ? await fetch("/api/settings/sleep-tracking", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) }).catch(() => undefined)
      : await fetch("/api/settings/energy-signals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signal: "input_rhythm", on }) }).catch(() => undefined);
    if (!response?.ok) { setValues((current) => ({ ...current, [key]: !on })); setNote("未保存，请重试"); } else setNote(on ? "已开启" : "已关闭，已删除记录（网页版的也会删除）");
  };
  const options = [{ value: "off", label: "关闭" }, { value: "on", label: "开启" }] as const;
  return <section className="st-card" aria-label="作息与键鼠节律">
    <header><h3>作息与键鼠节律</h3><small>只记长时间空闲的起止和每刻钟的输入秒数，不记按了哪个键、窗口是什么</small></header>
    <div className="st-row"><span className="st-row-label">作息记录<small>四小时以上无操作的起止，用于推算睡眠</small></span>
      <SegmentedControl label="作息记录" value={values.sleep ? "on" : "off"} options={options} onChange={(next) => void change("sleep", next === "on")} /></div>
    <div className="st-row"><span className="st-row-label">键鼠节律<small>每刻钟的输入秒数、停顿和指针移动距离</small></span>
      <SegmentedControl label="键鼠节律" value={values.rhythm ? "on" : "off"} options={options} onChange={(next) => void change("rhythm", next === "on")} /></div>
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}
