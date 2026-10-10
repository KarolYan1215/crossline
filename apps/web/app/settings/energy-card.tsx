"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";

export type EnergyStatus = {
  /** The model's reading of now: its level, how sure, and why. */
  now: { level: "low" | "medium" | "high"; confidence: "low" | "medium" | "high"; basis: string[] };
  nights: { screen: number; phone: number };
  reports: number; agreement: number;
  phoneConnected: boolean;
  /** 作息记录, its own consent: the start and end of long idle stretches, read as sleep. */
  sleepTracking: boolean;
};

const LEVEL = { low: "低", medium: "中", high: "高" } as const;
const SURE = { low: "把握低，需要时询问", medium: "把握中等", high: "把握高" } as const;

/**
 * 精力 (docs/one-input.md §5): what the model reads now and from what, and the phone's sleep record — a shortcut on the iPhone posts
 * last night's sleep each morning with a token made here (shown once). Only the start and end of each sleep and the day's heart-rate
 * figures are kept.
 */
export function EnergyCard({ status, phoneUrl }: { status: EnergyStatus; phoneUrl: string | null }) {
  const [token, setToken] = useState("");
  const [tracking, setTracking] = useState(status.sleepTracking);
  const [trackingNote, setTrackingNote] = useState("");
  const changeTracking = async (on: boolean) => {
    setTracking(on);
    const response = await fetch("/api/settings/sleep-tracking", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) }).catch(() => undefined);
    if (!response?.ok) { setTracking(!on); setTrackingNote("未保存，请重试"); } else setTrackingNote(on ? "已开启：从下一段长时间空闲开始记录" : "已关闭，已删除记录");
  };
  const [note, setNote] = useState("");
  const issue = async () => {
    const response = await fetch("/api/health/token", { method: "POST" }).catch(() => undefined);
    const body = await response?.json().catch(() => null) as { token?: string } | null;
    if (body?.token) { setToken(body.token); setNote("令牌只显示这一次；重新生成后旧的立即失效。"); } else setNote("未能生成，请重试");
  };
  const endpoint = `${phoneUrl ?? "https://<本机的私有网络地址>"}/api/health/sleep`;
  return <section className="st-card" aria-label="精力">
    <header><h3>精力</h3><small>由作息推算，按本人自评校准；把握低时才询问</small></header>
    <div className="st-row"><span className="st-row-label">作息记录<small>只记电脑 4 小时以上无活动（如夜间）的开始与结束时刻，用于推算睡眠；关闭即删除</small></span>
      <SegmentedControl label="作息记录" value={tracking ? "on" : "off"} onChange={(next) => void changeTracking(next === "on")}
        options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} /></div>
    {trackingNote && <p role="status" className="st-note">{trackingNote}</p>}
    <div className="st-row"><span className="st-row-label">现在<small>{SURE[status.now.confidence]}</small></span><b>{LEVEL[status.now.level]}</b></div>
    <ul className="st-list">{status.now.basis.map((line) => <li key={line}>{line}</li>)}</ul>
    <div className="st-row"><span className="st-row-label">依据<small>近 14 天</small></span>
      <span>电脑空闲推断 {status.nights.screen} 晚 · 手机记录 {status.nights.phone} 晚 · 自评 {status.reports} 次{status.reports ? `（与模型一致 ${Math.round(status.agreement * 100)}%）` : ""}</span></div>
    <details className="st-details advanced">
      <summary>手机睡眠数据{status.phoneConnected ? "（已设置令牌）" : ""}</summary>
      <ol className="st-steps">
        <li>在电脑上点「生成令牌」，复制令牌。</li>
        <li>iPhone 打开「快捷指令」→「自动化」→「新建个人自动化」→「起床时」（或每天 9:00），选「立即运行」。</li>
        <li>加动作「查找健康样本」：类型「睡眠分析」，开始日期「在过去 1 天内」。</li>
        <li>加「重复（对每一项）」：在其中用「词典」写 <b>start</b> = 重复项目的开始日期、<b>end</b> = 结束日期（日期格式选「ISO 8601」），再「添加到变量」<b>睡眠</b>。</li>
        <li>可选：再加「查找健康样本」类型「心率变异性」，取平均值。</li>
        <li>加「获取 URL 内容」：URL 填 <b>{endpoint}</b>，方法 POST，头部 <b>Authorization</b> = <b>Bearer 令牌</b>，请求体 JSON：<b>sleep</b> = 变量「睡眠」，<b>hrvMs</b> = 心率变异性（可不填），<b>day</b> = 当前日期（yyyy-MM-dd）。</li>
        <li>手机需连接同一私有网络（Tailscale）。只保存每段睡眠的起止和当天的心率数字。</li>
      </ol>
      <div className="st-row"><button type="button" className="secondary-button" onClick={() => void issue()}>{status.phoneConnected ? "重新生成令牌" : "生成令牌"}</button>
        {token && <b className="st-token">{token}</b>}</div>
      {note && <p role="status" className="st-note">{note}</p>}
    </details>
  </section>;
}
