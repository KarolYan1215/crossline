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
 * 精力 (docs/one-input.md §5, docs/energy-and-ecosystem.md §5): what the model reads now and from what, and the optional phone
 * connection — iPhone automations that post the bed and wake moments and a morning health summary with a token made here (shown once),
 * and Siri 「记一下」 with its own capture token. Set once, then nothing to do each day; never prompted.
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
  const [captureToken, setCaptureToken] = useState("");
  const issue = async (scope: "health" | "capture") => {
    const response = await fetch("/api/health/token", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope }) }).catch(() => undefined);
    const body = await response?.json().catch(() => null) as { token?: string } | null;
    if (!body?.token) { setNote("未能生成，请重试"); return; }
    if (scope === "capture") setCaptureToken(body.token); else setToken(body.token);
    setNote("令牌只显示这一次；重新生成后旧的立即失效。");
  };
  const base = phoneUrl ?? "https://<本机的私有网络地址>";
  const endpoint = `${base}/api/health/sleep`;
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
      <summary>手机接入（可选）{status.phoneConnected ? "：已设置" : ""}</summary>
      <p className="st-note">每项在 iPhone「快捷指令」→「自动化」里设置一次，选「立即运行」，之后每天无需操作。手机需连接同一私有网络（Tailscale）。只保存时刻和当天的汇总数字。</p>
      <ol className="st-steps">
        <li>点「生成健康令牌」，复制令牌。下面每个「获取 URL 内容」都填 URL <b>{endpoint}</b>、方法 POST、头部 <b>Authorization</b> = <b>Bearer 令牌</b>。</li>
        <li><b>起床时刻</b>：新建自动化「闹钟」→ 选「已停止」（或「睡眠」→「醒来」），动作「获取 URL 内容」，请求体 JSON：<b>events</b> = 一项词典 <b>type</b> = wake、<b>at</b> = 当前日期（ISO 8601）。</li>
        <li><b>入睡时刻</b>：新建自动化「睡眠」→「就寝时间开始」（或打开「睡眠」专注模式时），同上，<b>type</b> = bed。</li>
        <li><b>晨间健康汇总</b>：新建自动化每天 9:00。「查找健康样本」取过去 1 天的「睡眠分析」，用「重复」把每项写成词典 <b>start</b> / <b>end</b>（ISO 8601）加入变量 <b>睡眠</b>；再取「心率变异性」「静息心率」的平均值、「步数」「日照时间」的总和；有 Apple Watch 时取「手腕温度」与平时的差值。请求体 JSON：<b>sleep</b>、<b>hrvMs</b>、<b>restingHr</b>、<b>steps</b>、<b>daylightMin</b>、<b>wristTempDeltaC</b>（缺的不填）、<b>day</b> = 当前日期（yyyy-MM-dd）。</li>
        <li>Android：用健康数据转发应用（读取 Health Connect）按同样的 JSON 发送，并加 <b>source</b> = android-health。</li>
      </ol>
      <div className="st-row"><button type="button" className="secondary-button" onClick={() => void issue("health")}>{status.phoneConnected ? "重新生成健康令牌" : "生成健康令牌"}</button>
        {token && <b className="st-token">{token}</b>}</div>
      <ol className="st-steps">
        <li><b>Siri「记一下」</b>：新建快捷指令，命名「记一下」。动作「听写文本」，再「获取 URL 内容」：URL <b>{`${base}/api/capture/shortcut`}</b>、方法 POST、头部 <b>Authorization</b> = <b>Bearer 收集令牌</b>、请求体 JSON <b>text</b> = 听写的文本。之后说「嘿 Siri，记一下」即可收集，系统随后自动分析。</li>
      </ol>
      <div className="st-row"><button type="button" className="secondary-button" onClick={() => void issue("capture")}>生成收集令牌</button>
        {captureToken && <b className="st-token">{captureToken}</b>}</div>
      {note && <p role="status" className="st-note">{note}</p>}
    </details>
  </section>;
}
