"use client";

import { useEffect, useRef, useState } from "react";
import { flywheelLoops, redactPortrait, type PortraitReport } from "@crossline/core";
import { LineNetwork, type NetworkEdge } from "../ui/line-network";
import { AdviceMatrix, AllocationChart, EnergyScatter, Fit, GapChart, ValuesRadar } from "./portrait-charts";

type Line = { id: string; label: string; rank: number | null; hard: boolean };
type State = {
  report: PortraitReport | null; version: number; at: string | null; writing: boolean; blocker: string | null; lines: Line[];
  images: Record<string, string>; agentHours: number | null;
  next: { lines: Array<{ id: string; label: string; approved: string[]; drafts: string[] }>; hoursProposed: boolean; hoursSet: boolean };
};

const PRIORITY: Record<string, string> = { high: "优先", medium: "其次", low: "可缓" };
const roleOf = (line: Line) => line.hard ? "硬约束" : line.rank === 1 ? "底座" : line.rank ? `第 ${line.rank}` : "平行";

/** A section's illustration, when one was drawn for this version; nothing (not a placeholder) when not. */
function Illustration({ state, slot, className = "pt-art" }: { state: State; slot: string; className?: string }) {
  const at = state.images[slot];
  if (!at) return null;
  return <img className={className} src={`/api/portrait/image/${slot}?v=${encodeURIComponent(at)}`} alt="" aria-hidden="true" />;
}

/** The report's line-to-line feeds as the shared network (static here: in the report every drawn feed is the portrait's reading). */
const edgesOf = (report: PortraitReport): NetworkEdge[] => report.lines.items.flatMap((item) => item.feeds.map((feed, index) => ({
  id: `${item.lineId}>${feed.toLineId}:${index}`, from: item.lineId, to: feed.toLineId, kind: "", explanation: feed.how, status: "confirmed" as const })));

/**
 * The portrait report (decided 2026-10-08, redrawn the same day as charts and pictures): an editorial A4 document whose every section
 * leads with a figure — values as a radar, energy as a plane, the lines as a network with their share of attention, the say–do gap as a
 * dumbbell, the advice on an impact–effort matrix — and an illustration in one house style. The first half is what the shared version
 * contains, with every sensitive span hidden; it also comes as four 4:5 cards sized for social posts. The second half stays private.
 */
export function PortraitView({ initial, publicUrl, name }: { initial: State; publicUrl: string; name: string }) {
  const [state, setState] = useState(initial);
  const [mode, setMode] = useState<"full" | "share">("full");
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState("");
  const doc = useRef<HTMLDivElement>(null);
  const cards = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!publicUrl) return;
    void import("qrcode").then((QR) => QR.toDataURL(publicUrl, { margin: 1, width: 160 })).then(setQr).catch(() => setQr(""));
  }, [publicUrl]);
  // While the words are being written, and for a while after while the pictures land, the page refreshes itself.
  const drawing = Boolean(state.report?.imagery) && Object.keys(state.images).length === 0 && Boolean(state.at) && Date.now() - Date.parse(state.at!) < 30 * 60_000;
  useEffect(() => {
    if (!state.writing && !drawing) return;
    const timer = setInterval(() => void fetch("/api/portrait", { cache: "no-store" }).then((response) => response.json()).then((body: State) => setState(body)).catch(() => {}), 8000);
    return () => clearInterval(timer);
  }, [state.writing, drawing]);

  const write = async () => {
    setStatus("");
    const response = await fetch("/api/portrait", { method: "POST" }).catch(() => null);
    if (response?.ok) setState((current) => ({ ...current, writing: true, blocker: null })); else setStatus("未能开始生成，请稍后重试");
  };
  const download = (url: string, file: string) => { const link = document.createElement("a"); link.href = url; link.download = file; link.click(); };
  const png = async () => {
    if (!doc.current) return;
    setStatus("正在生成图片…");
    try {
      const { toPng } = await import("html-to-image");
      download(await toPng(doc.current, { pixelRatio: 2, backgroundColor: "#ffffff", filter: (node) => !(node instanceof HTMLElement && node.dataset.noExport !== undefined) }),
        `画像报告${mode === "share" ? "-分享版" : ""}-v${state.version}.png`);
      setStatus("");
    } catch { setStatus("图片生成失败，可改用下载 PDF"); }
  };
  /** Four 1080×1350 images, one per card, for posting. Always from the shared (redacted) version. */
  const shareCards = async () => {
    const nodes = [...(cards.current?.querySelectorAll<HTMLElement>("[data-card]") ?? [])];
    if (!nodes.length) return;
    setStatus("正在生成分享卡片…");
    try {
      const { toPng } = await import("html-to-image");
      for (const [index, node] of nodes.entries()) download(await toPng(node, { pixelRatio: 2, backgroundColor: "#FAF7F0" }), `画像卡片-${index + 1}-${node.dataset.card}.png`);
      setStatus("");
    } catch { setStatus("卡片生成失败，请重试"); }
  };

  const raw = state.report;
  if (!raw) return <section className="pt-empty">
    {state.writing ? <p role="status">正在生成画像报告：读取访谈、画像与主线，通常需要几分钟…</p>
      : <><p>{state.blocker ? `上次未能生成：${state.blocker}` : "访谈结束后生成画像报告：个人画像与洞察（可分享），现况洞察与可行建议（仅自己可见）。"}</p>
        <button type="button" className="primary-button" onClick={() => void write()}>生成画像报告</button></>}
    {status && <small role="status">{status}</small>}
  </section>;
  const report = mode === "share" ? redactPortrait(raw) : raw;
  const shared = redactPortrait(raw);
  const lineById = new Map(state.lines.map((line) => [line.id, line]));
  const ordered = [...state.lines].sort((a, b) => (a.hard === b.hard ? 0 : a.hard ? -1 : 1) || (a.rank ?? 99) - (b.rank ?? 99));
  const date = (state.at ?? new Date().toISOString()).slice(0, 10);
  const edges = edgesOf(report);
  const loops = flywheelLoops(edges);
  const name0 = (id: string) => lineById.get(id)?.label ?? id;
  const allocation = report.lines.items.map((item) => ({ lineId: item.lineId, name: name0(item.lineId), share: item.share, targetShare: item.targetShare }));
  const charging = report.energy.map.filter((item) => item.charge === "charge").map((item) => item.activity);
  const stats = [
    { value: ordered.length, label: "条主线" },
    { value: report.lines.items.reduce((sum, item) => sum + item.goals.length, 0), label: "个长期目标" },
    { value: loops.length, label: "个飞轮回路" },
    ...(state.agentHours !== null ? [{ value: state.agentHours, label: "小时 · 近 30 天编程助手" }] : [])
  ];
  const footer = <footer className="pt-footer">
    <span>Crossline · 个人画像报告 · {date}{state.version > 1 ? ` · 第 ${state.version} 版` : ""}</span>
    {qr && <span className="pt-qr"><img src={qr} alt="Crossline 主页二维码" width={72} height={72} /><small>{publicUrl}</small></span>}
  </footer>;

  return <div className="pt-wrap" data-mode={mode}>
    <div className="pt-toolbar" data-no-export="">
      <div className="pt-modes" role="tablist" aria-label="版本">
        <button type="button" role="tab" aria-selected={mode === "full"} onClick={() => setMode("full")}>完整版</button>
        <button type="button" role="tab" aria-selected={mode === "share"} onClick={() => setMode("share")}>分享版</button>
      </div>
      <small className="muted">{mode === "share" ? "只含前半部分，人名、机构、课程编号等已隐去" : "含现况洞察、可行建议与下一步，仅供自己"}</small>
      <button type="button" onClick={() => window.print()}>下载 PDF</button>
      <button type="button" onClick={() => void png()}>下载长图</button>
      <button type="button" onClick={() => void shareCards()}>下载分享卡片（4 张）</button>
      <button type="button" disabled={state.writing} onClick={() => void write()}>{state.writing ? "重新生成中…" : "重新生成"}</button>
      {drawing && <small role="status">配图生成中…</small>}
      {status && <small role="status">{status}</small>}
    </div>

    <div className="pt-doc" ref={doc}>
      <section className="pt-page pt-cover">
        <p className="pt-kicker">个人画像报告{name && mode === "full" ? ` · ${name}` : ""}</p>
        <Illustration state={state} slot="cover" className="pt-art pt-art-cover" />
        {report.cover.archetype && <p className="pt-archetype gen">{report.cover.archetype}</p>}
        <h1 className="gen">{report.cover.tagline || report.cover.portrait}</h1>
        {report.cover.tagline && <p className="gen pt-lead">{report.cover.portrait}</p>}
        <div className="pt-conflict"><small>核心矛盾</small><p className="gen">{report.cover.coreConflict}</p></div>
        <p className="pt-keywords">{report.cover.keywords.map((word) => <span key={word} className="tag">{word}</span>)}</p>
        <dl className="pt-stats">{stats.map((stat) => <div key={stat.label}><dt className="mono">{stat.value}</dt><dd>{stat.label}</dd></div>)}</dl>
        <ol className="pt-line-strip">{ordered.map((line) => <li key={line.id} data-line={line.id}><b>{line.label}</b><small>{roleOf(line)}</small></li>)}</ol>
        {footer}
      </section>

      <section className="pt-page">
        <h2><small>01</small>真问题</h2>
        <Illustration state={state} slot="problem" />
        <p className="gen pt-lead">{report.problem.statement}</p>
        <div className="pt-control" role="img" aria-label="需要接受的现实与可以设计的问题">
          <div className="pt-control-axis"><span>不可改变</span><span>可以设计</span></div>
          <div className="pt-cols">
            <div className="pt-col" data-tone="gravity"><h3>需要接受的现实</h3><ul>{report.problem.gravity.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>
            <div className="pt-col" data-tone="design"><h3>可以设计的问题</h3><ul>{report.problem.designable.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>
          </div>
        </div>
        <h3>思维误区 → 重新定义</h3>
        <div className="pt-reframes">{report.problem.reframes.map((item) => <div key={item.fallacy} className="pt-reframe">
          <s className="gen">{item.fallacy}</s><span aria-hidden="true">→</span><p className="gen">{item.reframe}</p></div>)}</div>
        {footer}
      </section>

      <section className="pt-page">
        <h2><small>02</small>指南针与能量地图</h2>
        <div className="pt-figure-row">
          {report.compass.values?.length ? <figure><Fit initial={300} max={340}>{(width) => <ValuesRadar values={report.compass.values!} size={width} />}</Fit><figcaption>价值取向（0–100，依据见悬停）</figcaption></figure>
            : <Illustration state={state} slot="compass" />}
          <div className="pt-compass">
            <div className="pt-north"><small>正北</small><p className="gen">↑ {report.compass.trueNorth}</p></div>
            <div><small>工作观</small><p className="gen">{report.compass.workView}</p></div>
            <div><small>人生观</small><p className="gen">{report.compass.lifeView}</p></div>
            <div><small>一致性</small><p className="gen">{report.compass.consistency}</p></div>
          </div>
        </div>
        <figure className="pt-figure"><Fit initial={520} max={680}>{(width) => <EnergyScatter map={report.energy.map} width={width} height={Math.round(Math.min(380, width * 0.7))} />}</Fit><figcaption>能量地图：实心为充电，空心为耗电；右上为擅长且热爱</figcaption></figure>
        <p className="gen pt-lead">{report.energy.summary}</p>
        {report.energy.flow.length > 0 && <div className="pt-flow"><small>心流时刻</small><ul>{report.energy.flow.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>}
        {footer}
      </section>

      <section className="pt-page">
        <h2><small>03</small>主线飞轮与长期目标</h2>
        <div className="pt-fly">
          <LineNetwork lines={ordered} edges={edges} title="主线之间如何互相供养" />
          <div className="pt-fly-side">
            <Illustration state={state} slot="lines" />
            <p className="gen pt-lead">{report.lines.allocation}</p>
          </div>
        </div>
        {allocation.some((item) => item.share !== undefined) && <figure className="pt-figure">
          <Fit initial={520} max={680}>{(width) => <AllocationChart items={allocation} label="精力分配：空心为现在，实心为建议" width={width} />}</Fit><figcaption>精力分配：空心为现在，实心为建议（%）</figcaption></figure>}
        <div className="pt-lines">{report.lines.items.map((item) => { const line = lineById.get(item.lineId); return <article key={item.lineId} data-line={item.lineId}>
          <header><b>{line?.label ?? item.lineId}</b>{line && <small>{roleOf(line)}</small>}</header>
          <p className="gen">{item.description}</p>
          <ul className="pt-goals">{item.goals.map((goal) => <li key={goal} className="gen">{goal}</li>)}</ul>
        </article>; })}</div>
        {footer}
      </section>

      <section className="pt-page">
        <h2><small>04</small>言行落差与锚</h2>
        {report.gap.pairs?.length ? <figure className="pt-figure"><Fit initial={520} max={680}>{(width) => <GapChart pairs={report.gap.pairs!} width={width} />}</Fit></figure> : null}
        <div className="pt-gap">
          <div><small>所说想要的</small><p className="gen">{report.gap.says}</p></div>
          <span aria-hidden="true" className="pt-gap-sign">≠</span>
          <div><small>行为在维护的</small><p className="gen">{report.gap.does}</p></div>
        </div>
        <p className="gen pt-lead">{report.gap.reading}</p>
        <ol className="pt-anchor">
          <li><small>锚</small><p className="gen">{report.gap.anchor}</p></li>
          <li><small>背后真正想要的</small><p className="gen">{report.gap.realWant}</p></li>
          <li><small>重新定义</small><p className="gen">{report.gap.reframe}</p></li>
        </ol>
        {footer}
      </section>

      {mode === "full" && <>
        <p className="pt-private" data-no-export="">以下为私有部分，不包含在分享版中</p>
        <section className="pt-page" data-private="">
          <h2><small>05</small>现况洞察与可行建议</h2>
          <div className="pt-figure-row">
            <AdviceMatrix insights={raw.insights} />
            <ol className="pt-insights">{raw.insights.map((item, index) => <li key={index} data-priority={item.priority}>
              <header><span className="pt-num mono">{index + 1}</span><span className="tag">{PRIORITY[item.priority]}</span><small>解决：<span className="gen">{item.solves}</span></small></header>
              <p className="gen pt-insight">{item.insight}</p>
              <p className="gen"><b>建议</b> {item.advice}</p>
            </li>)}</ol>
          </div>
          {footer}
        </section>
        <section className="pt-page" data-private="">
          <h2><small>06</small>Crossline 下一步</h2>
          <ol className="pt-next">
            <li data-done={state.next.hoursSet || undefined}><b>确认可用时段</b><span>{state.next.hoursSet ? "已设定" : state.next.hoursProposed ? "访谈已提议，在计划页预览后采用" : "在计划页设定工作时段"}</span></li>
            {state.next.lines.map((line) => <li key={line.id} data-line={line.id} data-done={line.approved.length > 0 || undefined}>
              <b>{line.label} · 里程碑</b>
              <span>{line.approved.length ? `已批准 ${line.approved.length} 个：${line.approved.slice(0, 3).join("、")}` : line.drafts.length ? `${line.drafts.length} 个草稿待批准` : "尚未设计，可在访谈页生成草稿"}</span>
            </li>)}
            <li><b>任务与日程</b><span>里程碑批准后自动倒推任务；任务拆成步骤，排进可用时段，硬约束的固定日程为骨架。</span></li>
          </ol>
          {footer}
        </section>
      </>}
    </div>

    <section className="pt-cards" ref={cards} aria-label="分享卡片预览" data-no-export="">
      <h2>分享卡片 <small>4:5，适合社交平台；内容来自分享版，敏感信息已隐去</small></h2>
      <div className="pt-card-row">
        <article className="pt-card pt-card-cover" data-card="cover">
          <Illustration state={state} slot="cover" className="pt-card-art" />
          <div className="pt-card-body">
            <small className="pt-card-kicker">我的画像</small>
            <b className="pt-card-title gen">{shared.cover.archetype || shared.cover.keywords[0] || "个人画像"}</b>
            <p className="gen">{shared.cover.tagline || shared.cover.portrait}</p>
            <p className="pt-keywords">{shared.cover.keywords.slice(0, 4).map((word) => <span key={word} className="tag">{word}</span>)}</p>
            {!state.images.cover && <div className="pt-card-conflict"><small>核心矛盾</small><p className="gen">{shared.cover.coreConflict}</p></div>}
            {!state.images.cover && <dl className="pt-stats">{stats.slice(0, 3).map((stat) => <div key={stat.label}><dt className="mono">{stat.value}</dt><dd>{stat.label}</dd></div>)}</dl>}
          </div>
          <small className="pt-card-foot">Crossline · 个人画像</small>
        </article>
        <article className="pt-card" data-card="compass">
          <small className="pt-card-kicker">指南针</small>
          {shared.compass.values?.length ? <ValuesRadar values={shared.compass.values} size={300} /> : <Illustration state={state} slot="compass" className="pt-card-art" />}
          <p className="pt-card-north gen">↑ {shared.compass.trueNorth}</p>
          <small className="pt-card-foot">Crossline · 个人画像</small>
        </article>
        <article className="pt-card" data-card="energy">
          <small className="pt-card-kicker">能量地图</small>
          <EnergyScatter map={shared.energy.map} width={460} height={340} />
          {charging.length > 0 && <p className="gen">充电：{charging.slice(0, 4).join("、")}</p>}
          <small className="pt-card-foot">Crossline · 个人画像</small>
        </article>
        <article className="pt-card" data-card="flywheel">
          <small className="pt-card-kicker">主线飞轮</small>
          <LineNetwork lines={ordered} edges={edgesOf(shared)} title="" />
          <ul className="pt-card-goals">{shared.lines.items.slice(0, 4).map((item) => item.goals[0] ? <li key={item.lineId} data-line={item.lineId}><b>{name0(item.lineId)}</b> <span className="gen">{item.goals[0]}</span></li> : null)}</ul>
          <small className="pt-card-foot">Crossline · 个人画像</small>
        </article>
      </div>
    </section>
  </div>;
}
