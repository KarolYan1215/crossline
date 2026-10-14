"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { CHRONOTYPE_LABEL, PVT_LAPSE_MS, quizType, type MctqLiteInput, type MctqLiteResult, type PortraitType, type PvtSummary } from "@crossline/core/assess";
import type { EnergyRhythm } from "@crossline/core/energy-rhythm";
import { rhythmFromAnswers } from "../lib/usual-nights";

/** On every card and page of the result. */
const DISCLAIMER = "基于自评与反应测试的估计，非医学诊断";
const PAPER = "#F6F2EA", INK = "#1C1A17", MUTED = "#4F4A42", TRACK = "#DDD5C7";

const clock = (hours: number) => { const m = ((Math.round(hours * 60) % 1440) + 1440) % 1440; return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`; };
const signed = (hours: number) => `${hours > 0 ? "+" : hours < 0 ? "−" : ""}${Math.abs(hours).toFixed(1)} 小时`;
const groupStyle = (type: PortraitType) => ({ ["--group" as string]: type.group.colour, ["--group-tint" as string]: type.group.tint });

/**
 * A 540×720 card shown at whatever width the screen has: the wrapper is scaled, the card itself is not, so the exported image is always
 * the card at its own size.
 */
function Scaled({ children }: { children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    if (!frame.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => setScale(Math.min(1, (entry?.contentRect.width ?? 540) / 540)));
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={frame} className="as-card-frame" style={{ height: 720 * scale }}>
    <div style={{ transform: `scale(${scale})`, transformOrigin: "0 0", width: 540 }}>{children}</div>
  </div>;
}

/** Draws its child at the width it has, so chart labels stay 12px on a phone. */
function Wide({ children }: { children: (width: number) => ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(680);
  useEffect(() => {
    if (!box.current || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => { const next = Math.round(Math.min(680, entry?.contentRect.width ?? 680)); if (next > 0) setWidth(next); });
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  return <div ref={box} className="as-wide">{children(width)}</div>;
}

/** The four axes as bars from the middle towards the pole leaned to, with the percentage. */
function Axes({ type }: { type: PortraitType }) {
  return <ul className="as-axes">{type.axes.map((axis) => {
    const right = axis.score >= 50;
    return <li key={axis.id}>
      <span data-on={!right || undefined}>{axis.left}</span>
      <span className="as-axis-track" role="img" aria-label={`${axis.label} ${axis.percent}%`}>
        <i style={{ left: `${right ? 50 : axis.score}%`, width: `${Math.abs(axis.score - 50)}%` }} />
      </span>
      <span data-on={right || undefined}>{axis.right}</span>
      <b>{axis.percent}% {axis.label}</b>
    </li>;
  })}</ul>;
}

/** The usual day's curve: sleep shaded, the best three hours in the group colour. */
function Curve({ rhythm, width, height }: { rhythm: EnergyRhythm; width: number; height: number }) {
  const pad = { left: 12, right: 12, top: 24, bottom: 26 };
  const values = rhythm.curve.flatMap((point) => point.value === null ? [] : [point.value]);
  if (!values.length) return null;
  const top = Math.max(...values) + 0.5, bottom = Math.min(...values) - 0.5;
  const x = (hour: number) => pad.left + (hour / 24) * (width - pad.left - pad.right);
  const y = (value: number) => pad.top + ((top - value) / (top - bottom)) * (height - pad.top - pad.bottom);
  let open = false;
  const path = rhythm.curve.map((point) => { if (point.value === null) { open = false; return ""; } const step = `${open ? "L" : "M"}${x(point.hour).toFixed(1)},${y(point.value).toFixed(1)}`; open = true; return step; }).join(" ");
  const from = rhythm.sleep.from >= 24 ? rhythm.sleep.from - 24 : rhythm.sleep.from;
  const spans = rhythm.sleep.from >= 24 ? [[from, rhythm.sleep.to]] : [[0, rhythm.sleep.to], [from, 24]];
  const bottomY = height - pad.bottom;
  return <svg className="as-curve" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img"
    aria-label={`一日精力曲线，最佳时段 ${clock(rhythm.peak.start)}–${clock(rhythm.peak.end)}`}>
    {spans.map(([a, b]) => <rect key={a} x={x(a!)} y={pad.top} width={x(b!) - x(a!)} height={bottomY - pad.top} fill="#ECE5D8" />)}
    <rect x={x(rhythm.peak.start)} y={pad.top} width={x(rhythm.peak.end) - x(rhythm.peak.start)} height={bottomY - pad.top} style={{ fill: "var(--group)" }} fillOpacity=".18" />
    <text x={x((rhythm.peak.start + rhythm.peak.end) / 2)} y={pad.top - 8} textAnchor="middle" fontSize="12" fontWeight="700" fill={INK}>最佳 {clock(rhythm.peak.start)}–{clock(rhythm.peak.end)}</text>
    <path d={path} fill="none" stroke={INK} strokeWidth="2.5" strokeLinejoin="round" />
    <line x1={x(0)} x2={x(24)} y1={bottomY} y2={bottomY} stroke={INK} />
    {[0, 6, 12, 18, 24].map((hour) => <text key={hour} x={x(hour)} y={height - 8} textAnchor={hour === 0 ? "start" : hour === 24 ? "end" : "middle"} fontSize="12" fill={MUTED}>{hour}:00</text>)}
  </svg>;
}

/** Reaction times in order, the lapse line dashed. */
function RtStrip({ rts, width, height }: { rts: number[]; width: number; height: number }) {
  if (!rts.length) return null;
  const max = Math.max(600, ...rts.map((rt) => Math.min(rt, 1000)));
  const x = (index: number) => 8 + (index / Math.max(1, rts.length - 1)) * (width - 16);
  const y = (rt: number) => 8 + (1 - Math.min(rt, max) / max) * (height - 24);
  return <svg className="as-curve" viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label="每次反应的时间">
    <line x1={8} x2={width - 8} y1={y(PVT_LAPSE_MS)} y2={y(PVT_LAPSE_MS)} stroke={MUTED} strokeDasharray="4 4" />
    <text x={width - 8} y={y(PVT_LAPSE_MS) - 4} textAnchor="end" fontSize="12" fill={MUTED}>{PVT_LAPSE_MS} ms 失误线</text>
    {rts.map((rt, index) => <circle key={index} cx={x(index)} cy={y(rt)} r="2.5" fill={rt >= PVT_LAPSE_MS ? "#fff" : INK} stroke={INK} />)}
    <line x1={8} x2={width - 8} y1={height - 16} y2={height - 16} stroke={TRACK} />
  </svg>;
}

/**
 * The result: the 3:4 type card and the 3:4 energy card (each exported at 1080×1440), then the whole result as one long page; saved as
 * images through `html-to-image` or printed to PDF with the print stylesheet. The QR code points to the waitlist.
 */
export function Result({ answers, sleep, chrono, pvt, waitlistUrl, onRestart }: {
  answers: Record<string, number>; sleep: MctqLiteInput; chrono: MctqLiteResult; pvt: { summary: PvtSummary; rts: number[] } | null;
  waitlistUrl: string; onRestart: () => void;
}) {
  const type = useMemo(() => quizType(answers), [answers]);
  const rhythm = useMemo(() => rhythmFromAnswers(sleep), [sleep]);
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState("");
  const typeCard = useRef<HTMLDivElement>(null), energyCard = useRef<HTMLDivElement>(null), long = useRef<HTMLDivElement>(null);
  useEffect(() => { void import("qrcode").then((QR) => QR.toDataURL(waitlistUrl, { margin: 1, width: 160 })).then(setQr).catch(() => setQr("")); }, [waitlistUrl]);

  const save = async () => {
    setStatus("正在生成图片…");
    try {
      const { toBlob } = await import("html-to-image");
      const names = ["思维模式类型.png", "精力节律.png", "速测结果.png"];
      const files: File[] = [];
      for (const [index, node] of [typeCard.current, energyCard.current, long.current].entries()) {
        const blob = node ? await toBlob(node, { pixelRatio: 2, backgroundColor: PAPER }) : null;
        if (blob) files.push(new File([blob], names[index]!, { type: "image/png" }));
      }
      const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
      if (nav.canShare?.({ files })) await nav.share({ files, title: "我的 Crossline 速测结果" });
      else for (const file of files) { const link = document.createElement("a"); link.href = URL.createObjectURL(file); link.download = file.name; link.click(); }
      setStatus("");
    } catch (error) { setStatus(error instanceof DOMException && error.name === "AbortError" ? "" : "图片生成失败，请重试"); }
  };

  const chronoLabel = chrono.chronotype ? CHRONOTYPE_LABEL[chrono.chronotype] : "无法校正";
  const energyRows = [
    { title: "早晚型", value: chronoLabel, detail: chrono.msfSc === null ? "休息日用闹钟，无法校正睡眠中点" : `休息日校正睡眠中点 ${clock(chrono.msfSc)}` },
    { title: "社会时差", value: signed(chrono.sjlRel), detail: chrono.sjlRel === 0 ? "休息日与工作日一致" : `休息日睡眠中点比工作日${chrono.sjlRel > 0 ? "晚" : "早"}` },
    { title: "睡眠时长", value: `${chrono.sdWeek.toFixed(1)} 小时`, detail: `工作日 ${chrono.sdWork.toFixed(1)} · 休息日 ${chrono.sdFree.toFixed(1)}` },
    pvt ? { title: "反应中位数", value: pvt.summary.medianRt === null ? "—" : `${pvt.summary.medianRt} ms`, detail: `失误 ${pvt.summary.lapses} 次 · 抢按 ${pvt.summary.falseStarts} 次` }
      : { title: "反应测试", value: "未做", detail: "可重新开始补做" }
  ];
  const footer = <footer className="as-foot">
    <span>{DISCLAIMER} · Crossline 速测</span>
    {qr && <span className="as-qr"><img src={qr} alt="加入 Crossline 内测的二维码" width={64} height={64} /><small>加入内测</small></span>}
  </footer>;

  return <div className="as-result">
    <div className="as-toolbar" data-no-print="">
      <button type="button" className="as-primary" onClick={() => void save()}>保存图片</button>
      <button type="button" onClick={() => window.print()}>打印 / 存为 PDF</button>
      <button type="button" onClick={onRestart}>重新开始</button>
      {status && <small role="status">{status}</small>}
    </div>

    <div className="as-cards">
      <Scaled><div ref={typeCard} className="as-card" style={groupStyle(type)}>
        <small className="as-kicker">Crossline 思维模式类型</small>
        <div className="as-card-type"><p className="as-code">{type.code}</p><b className="as-name">{type.name}</b>
          <p className="as-group"><span>{type.group.name}</span> {type.group.blurb}</p></div>
        <p className="as-blurb">「{type.blurb}」</p>
        <Axes type={type} />
        {footer}
      </div></Scaled>
      <Scaled><div ref={energyCard} className="as-card" style={groupStyle(type)}>
        <small className="as-kicker">Crossline 精力节律</small>
        <div className="as-peak"><small>最佳时段</small><b>{clock(rhythm.peak.start)}–{clock(rhythm.peak.end)}</b></div>
        <Curve rhythm={rhythm} width={460} height={200} />
        <dl className="as-stats">{energyRows.map((row) => <div key={row.title}><dt>{row.title}</dt><dd><b>{row.value}</b><small>{row.detail}</small></dd></div>)}</dl>
        {footer}
      </div></Scaled>
    </div>

    <article ref={long} className="as-long" style={groupStyle(type)}>
      <header><p className="as-kicker">Crossline 速测结果</p><h1>{type.code} · {type.name}</h1><p>{type.group.name}：{type.group.blurb}。{type.blurb}。</p></header>
      <section><h2>四条轴</h2><Axes type={type} />
        <p className="as-note">每条轴 4 题、各有 2 题反向计分；50% 表示两端持平。类型只描述偏好，不评价高低。</p></section>
      <section><h2>精力节律</h2>
        <Wide>{(width) => <Curve rhythm={rhythm} width={width} height={220} />}</Wide>
        <dl className="as-stats as-stats-wide">{energyRows.map((row) => <div key={row.title}><dt>{row.title}</dt><dd><b>{row.value}</b><small>{row.detail}</small></dd></div>)}</dl>
        <p className="as-note">曲线按你填的作息，用三过程模型（Åkerstedt 等，2004）画出通常一天的警觉度，没有个人校准。早晚型和社会时差按慕尼黑时型问卷（Roenneberg 等）的算法：社会时差 = 休息日睡眠中点 − 工作日睡眠中点；早晚型按校正后的休息日睡眠中点分档（3:00 前偏早、5:00 起偏晚），这是阅读约定，不是人群常模。</p></section>
      {pvt && <section><h2>反应测试</h2>
        <Wide>{(width) => <RtStrip rts={pvt.rts} width={width} height={140} />}</Wide>
        <p className="as-note">共 {pvt.summary.stimuli} 次，有效 {pvt.summary.valid} 次；中位数 {pvt.summary.medianRt ?? "—"} ms，平均反应速度 {pvt.summary.meanSpeed ?? "—"} /秒；{PVT_LAPSE_MS} ms 及以上或未反应算失误（{pvt.summary.lapses} 次），100 ms 以下或数字出现前点击算抢按（{pvt.summary.falseStarts} 次）。
          {pvt.summary.reliable ? "" : "有效反应不足 20 次，中位数仅供参考。"}不与常模比较：PVT-B 的验证研究（Basner 等，2011）没有公布可对照的静息基线均值和标准差。</p></section>}
      {footer}
    </article>
  </div>;
}
