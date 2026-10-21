"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { SetupGuide } from "../ui/setup-guide";
import { captureShortcutGuide, phoneHealthGuide, recordsGuide } from "../../lib/setup-guides";

export type EnergyStatus = {
  /** The model's reading of now: its level, how sure, and why. */
  now: { level: "low" | "medium" | "high"; confidence: "low" | "medium" | "high"; basis: string[] };
  nights: { screen: number; phone: number };
  reports: number; agreement: number;
  phoneConnected: boolean;
  /** 作息记录, its own consent: the start and end of long idle stretches, read as sleep. */
  sleepTracking: boolean;
  /** 键鼠节律 and 摄像头精力采样, each its own consent (docs/energy-and-ecosystem.md §8). */
  inputRhythm: boolean;
  camera: boolean;
  /** 手机健康数据, its own consent: on once the health token is made; off deletes the phone's record and the token. */
  phoneHealth: boolean;
  /** The latest day the phone sent steps or daylight for. */
  phoneDaily?: { day: string; steps?: number; daylightMin?: number };
  /**
   * Each turned-on signal's backtest against the person's own reports: it moves anything only once `enabled` — a reading of now, or for
   * the phone's steps and daylight (`use: "capacity"`) only the day's capacity, downwards.
   */
  signals: Array<{ id: string; label: string; use: "now" | "capacity"; evaluated: number; hitsWith: number; hitsWithout: number; enabled: boolean }>;
};

const LEVEL = { low: "低", medium: "中", high: "高" } as const;
const SURE = { low: "把握低，需要时询问", medium: "把握中等", high: "把握高" } as const;

/**
 * 精力 (docs/one-input.md §5, docs/energy-and-ecosystem.md §5): what the model reads now and from what, and the optional phone
 * connection — iPhone automations that post the bed and wake moments and a morning health summary with a token made here (shown once),
 * and Siri 「记一下」 with its own capture token. Set once, then nothing to do each day; never prompted.
 */
export function EnergyCard({ status, phoneUrl, hostSignals = true, privateNetwork = true }: { status: EnergyStatus; phoneUrl: string | null;
  /** False for a guest: 作息记录 and 键鼠节律 read the computer Crossline runs on, which is not theirs. */
  hostSignals?: boolean;
  /** The phone reaches this computer over the private network (not the hosted address), which the guides say. */
  privateNetwork?: boolean }) {
  const [token, setToken] = useState("");
  const [tracking, setTracking] = useState(status.sleepTracking);
  const [trackingNote, setTrackingNote] = useState("");
  const changeTracking = async (on: boolean) => {
    setTracking(on);
    const response = await fetch("/api/settings/sleep-tracking", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) }).catch(() => undefined);
    if (!response?.ok) { setTracking(!on); setTrackingNote("未保存，请重试"); } else setTrackingNote(on ? "已开启：从下一段长时间空闲开始记录" : "已关闭，已删除记录");
  };
  const [note, setNote] = useState("");
  const [rhythm, setRhythm] = useState(status.inputRhythm);
  const [camera, setCamera] = useState(status.camera);
  const [phoneHealth, setPhoneHealth] = useState(status.phoneHealth);
  const [signalNote, setSignalNote] = useState("");
  const changeSignal = async (signal: "input_rhythm" | "camera" | "phone_health", on: boolean) => {
    const set = signal === "camera" ? setCamera : signal === "phone_health" ? setPhoneHealth : setRhythm;
    set(on);
    const response = await fetch("/api/settings/energy-signals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signal, on }) }).catch(() => undefined);
    if (!response?.ok) { set(!on); setSignalNote("未保存，请重试"); return; }
    setSignalNote(on ? signal === "camera" ? "已开启：本机桌面页面打开时，每 20 分钟采样 20 秒" : signal === "phone_health" ? "已开启：生成健康令牌后，手机发来的数据开始保存"
      : "已开启：从下一分钟开始记录" : signal === "phone_health" ? "已关闭，已删除手机记录，健康令牌已失效" : "已关闭，已删除记录");
  };
  const [captureToken, setCaptureToken] = useState("");
  const [recordsToken, setRecordsToken] = useState("");
  const issue = async (scope: "health" | "capture" | "records") => {
    const response = await fetch("/api/health/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope }) }).catch(() => undefined);
    const body = await response?.json().catch(() => null) as { token?: string } | null;
    if (!body?.token) { setNote("未能生成，请重试"); return; }
    if (scope === "capture") setCaptureToken(body.token); else if (scope === "records") setRecordsToken(body.token); else { setToken(body.token); setPhoneHealth(true); }
    setNote("令牌只显示这一次；重新生成后旧的立即失效。");
  };
  const at = { base: phoneUrl ?? "https://<本机的私有网络地址>", privateNetwork };
  return <section className="st-card" aria-label="精力">
    <header><h3>精力</h3><small>由作息推算，按本人自评校准；把握低时才询问</small></header>
    {hostSignals && <><div className="st-row"><span className="st-row-label">作息记录<small>只记电脑 4 小时以上无活动（如夜间）的开始与结束时刻，用于推算睡眠；关闭即删除</small></span>
      <SegmentedControl label="作息记录" value={tracking ? "on" : "off"} onChange={(next) => void changeTracking(next === "on")}
        options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} /></div>
    {trackingNote && <p role="status" className="st-note">{trackingNote}</p>}
    <div className="st-row"><span className="st-row-label">键鼠节律<small>只记每 15 分钟内有输入的秒数、5 秒以上的停顿次数和鼠标移动距离；不记按键、内容和窗口；关闭即删除</small></span>
      <SegmentedControl label="键鼠节律" value={rhythm ? "on" : "off"} onChange={(next) => void changeSignal("input_rhythm", next === "on")}
        options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} /></div></>}
    <div className="st-row"><span className="st-row-label">摄像头精力采样<small>仅电脑、页面在前台时：每 20 分钟开 20 秒，在本机算眨眼、闭眼比例与心率，只存这几个数；画面不存不传；关闭即删除</small></span>
      <SegmentedControl label="摄像头精力采样" value={camera ? "on" : "off"} onChange={(next) => void changeSignal("camera", next === "on")}
        options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} /></div>
    <div className="st-row"><span className="st-row-label">手机健康数据<small>手机快捷指令发来的睡眠、起床与入睡时刻，以及当天的心率、手腕温度、步数和日照；生成健康令牌即开启；关闭即删除，令牌失效</small></span>
      <SegmentedControl label="手机健康数据" value={phoneHealth ? "on" : "off"} onChange={(next) => void changeSignal("phone_health", next === "on")}
        options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} /></div>
    {/* The token button and its tutorial sit right under the switch they turn on (2026-10-21: the steps used to be folded at the card's foot). */}
    <div className="st-row"><span className="st-row-label">手机接入<small>{status.phoneConnected ? "已设置过健康令牌；重新生成后旧的立即失效" : "生成健康令牌，再按下方教程在手机上设置一次"}</small></span>
      <button type="button" className="secondary-button" onClick={() => void issue("health")}>{status.phoneConnected || token ? "重新生成健康令牌" : "生成健康令牌"}</button></div>
    {token && <p className="st-note">健康令牌：<b className="st-token">{token}</b></p>}
    <SetupGuide guide={phoneHealthGuide(at)} />
    {phoneHealth && status.phoneDaily &&<div className="st-row"><span className="st-row-label">步数与日照<small>{Number(status.phoneDaily.day.slice(5, 7))}/{Number(status.phoneDaily.day.slice(8, 10))} 手机发来；与本人近 28 天比，明显偏向精力低的一侧时才下调当天可排的量</small></span>
      <span>{status.phoneDaily.steps !== undefined ? `${status.phoneDaily.steps.toLocaleString("zh-CN")} 步` : "步数未发"} · {status.phoneDaily.daylightMin !== undefined ? `日照 ${status.phoneDaily.daylightMin} 分钟` : "日照未发"}</span></div>}
    {signalNote && <p role="status" className="st-note">{signalNote}</p>}
    {status.signals.length > 0 && <ul className="st-list">{status.signals.map((signal) => <li key={signal.id}>{signal.label}：{signal.enabled
      ? `${signal.use === "capacity" ? "已用于下调当天容量" : "已用于修正当前精力"}（回测 ${signal.evaluated} 次自评，命中 ${signal.hitsWithout} → ${signal.hitsWith}）`
      : signal.evaluated ? `验证中：回测 ${signal.evaluated} 次自评，未比不用时更准，暂不使用` : "验证中：还需要更多自评"}</li>)}</ul>}
    <div className="st-row"><span className="st-row-label">现在<small>{SURE[status.now.confidence]}</small></span><b>{LEVEL[status.now.level]}</b></div>
    <ul className="st-list">{status.now.basis.map((line) => <li key={line}>{line}</li>)}</ul>
    <div className="st-row"><span className="st-row-label">依据<small>近 14 天</small></span>
      <span>电脑空闲推断 {status.nights.screen} 晚 · 手机记录 {status.nights.phone} 晚 · 自评 {status.reports} 次{status.reports ? `（与模型一致 ${Math.round(status.agreement * 100)}%）` : ""}</span></div>
    <div className="st-row"><span className="st-row-label">Siri「记一下」<small>对 Siri 说一句话直接进收集；收集令牌只能写收集</small></span>
      <button type="button" className="secondary-button" onClick={() => void issue("capture")}>{captureToken ? "重新生成收集令牌" : "生成收集令牌"}</button></div>
    {captureToken && <p className="st-note">收集令牌：<b className="st-token">{captureToken}</b></p>}
    <SetupGuide guide={captureShortcutGuide(at)} />
    <div className="st-row"><span className="st-row-label">手机自动记账<small>有财富主线时，付款与到账通知记成收支；记账令牌只能写收支记录</small></span>
      <button type="button" className="secondary-button" onClick={() => void issue("records")}>{recordsToken ? "重新生成记账令牌" : "生成记账令牌"}</button></div>
    {recordsToken && <p className="st-note">记账令牌：<b className="st-token">{recordsToken}</b></p>}
    <SetupGuide guide={recordsGuide(at)} />
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}
