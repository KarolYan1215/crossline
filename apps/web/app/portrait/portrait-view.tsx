"use client";

import { useEffect, useRef, useState } from "react";
import { portraitLabels, portraitType, redactPortrait, type EnergyRhythm, type PortraitReport, type PortraitType, type SayDoReading } from "@crossline/core";
import { LineNetwork, type NetworkEdge } from "../ui/line-network";
import { AdviceMatrix, DivergingAxes, EnergyScatter, Fit, GapChart, IdentityBars, RhythmChart, ValuesRadar } from "./portrait-charts";
import { radarValues, rhythmStats } from "./poster-geometry";

type Line = { id: string; label: string; rank: number | null; hard: boolean };
type State = {
  report: PortraitReport | null; version: number; at: string | null; writing: boolean; blocker: string | null; lines: Line[];
  images: Record<string, string>; sayDo: SayDoReading; rhythm: EnergyRhythm;
  next: { lines: Array<{ id: string; label: string; approved: string[]; drafts: string[] }>; hoursProposed: boolean; hoursSet: boolean };
};

const PRIORITY: Record<string, string> = { high: "优先", medium: "其次", low: "可缓" };
/** On the share card and the long image (decided 2026-10-12): what the portrait is, against the Barnum effect. */
const CREDIBILITY = "基于访谈的推断，不是标准化心理测验";
/** Under the energy curve: what it is. */
const RHYTHM_CREDIBILITY = "按睡眠记录与自评校准的模型估计，非医学诊断";
const groupStyle = (type: PortraitType | null) => type ? { ["--group" as string]: type.group.colour, ["--group-tint" as string]: type.group.tint } : undefined;
/** What the curve rests on, in one line. */
const rhythmBasis = (rhythm: EnergyRhythm) => rhythm.nights
  ? `依据近四周 ${rhythm.nights} 晚睡眠记录${rhythm.reports.length ? `与 ${rhythm.reports.length} 次自评` : ""}；三过程模型（Åkerstedt 等，2004）`
  : "尚无睡眠记录：按 23:30–7:30 的通用作息画出；三过程模型（Åkerstedt 等，2004）";
/** The paper colour of style A, also the background of the exported images. */
const PAPER = "#F6F2EA";
const roleOf = (line: Line) => line.hard ? "硬约束" : line.rank === 1 ? "底座" : line.rank ? `第 ${line.rank}` : "平行";

/** The report's line-to-line feeds as the shared network. */
const edgesOf = (report: PortraitReport): NetworkEdge[] => report.lines.items.flatMap((item) => item.feeds.map((feed, index) => ({
  id: `${item.lineId}>${feed.toLineId}:${index}`, from: item.lineId, to: feed.toLineId, kind: "", explanation: feed.how, status: "confirmed" as const })));

/** The cartoon figure for this version, when drawn. */
function Figure({ state, className }: { state: State; className: string }) {
  const at = state.images.character;
  return at ? <img className={className} src={`/api/portrait/image/character?v=${encodeURIComponent(at)}`} alt="代表这一类型的卡通形象" /> : null;
}

/** A hard-coded section title, set in the poster's serif, with its number. */
const Heading = ({ number, children }: { number: string; children: string }) => <h2><small>{number}</small><span className="pt-serif">{children}</span></h2>;

/**
 * The shareable half in style A 「编辑杂志」 (decided 2026-10-12; reordered 2026-10-14, docs/energy-and-ecosystem.md §7): the type as a
 * result page (figure on a disc of the group's colour, code, name, group), the one-line tagline, the four axes as diverging bars with
 * their reasons, the labels computed in code with the other lines as identity bars; then the energy rhythm, the values and energy map,
 * and the lines as a flywheel. The core conflict and the say–do comparison are private. Rendered twice — from the person's own report on
 * screen and from the redacted report off screen — and only the second is ever exported.
 */
function SharePart({ report, state, ordered }: { report: PortraitReport; state: State; ordered: Line[] }) {
  const type = portraitType(report);
  const name = (id: string) => state.lines.find((line) => line.id === id)?.label ?? id;
  const { cells, identities } = portraitLabels(report, { lineLabel: name });
  const edges = edgesOf(report);
  const allLines = [...report.lines.items].sort((a, b) => (b.targetShare ?? 0) - (a.targetShare ?? 0))
    .flatMap((item) => item.targetShare === undefined ? [] : [{ lineId: item.lineId, label: name(item.lineId), target: item.targetShare, now: item.share ?? null }]);
  const values = radarValues(report.compass.values);
  return <>
    <section className="pt-page pt-type" style={groupStyle(type)}>
      <header className="pt-poster-head"><p className="pt-kicker">Crossline 思维模式类型</p><p className="pt-credibility">{CREDIBILITY}</p></header>
      <div className="pt-type-head">
        <div className="pt-figure-disc"><Figure state={state} className="pt-figure-img" /></div>
        <div className="pt-type-id">
          {type ? <>
            <p className="pt-type-code pt-serif">{type.code}</p>
            <h1 className="pt-type-name pt-serif">{type.name}</h1>
            <p className="pt-type-group"><span><b className="pt-serif">{type.group.name}</b> · {type.group.blurb}</span></p>
            {/* The writer's paragraph to the person, ended in code with the type the scores make, so the two never disagree. */}
            <p className="pt-type-blurb" data-reading="">{type.summary
              ? <><span className="gen">{type.summary.replace(/[，,。.；;、\s]+$/u, "")}，</span>你是 {type.code} {type.name}。</>
              : type.blurb}</p>
          </> : <h1 className="pt-type-name gen">{report.cover.archetype ?? report.cover.keywords[0] ?? "个人画像"}</h1>}
        </div>
      </div>
      {report.cover.tagline && <p className="pt-tagline gen">「{report.cover.tagline}」</p>}
      {type && <DivergingAxes type={type} evidence />}
      {(cells.length > 0 || identities.length > 0) && <dl className="pt-labels">
        {cells.map((cell) => <div key={cell.title}><dt>{cell.title}</dt>
          <dd><b className={cell.title === "核心词" ? "gen" : cell.title === "价值核心" ? "pt-serif" : undefined}>{cell.value}</b>{cell.detail && <small>{cell.detail}</small>}</dd></div>)}
        {identities.length > 0 && <div className="pt-labels-wide"><dt>身份</dt><dd><IdentityBars rows={identities} /></dd></div>}
      </dl>}
      <div className="pt-summary">
        <p className="gen pt-lead">{report.cover.portrait}</p>
        <p className="pt-keywords">{report.cover.keywords.map((word) => <span key={word} className="tag gen">{word}</span>)}</p>
      </div>
    </section>

    <section className="pt-page" style={groupStyle(type)}>
      <Heading number="01">精力节律</Heading>
      <figure className="pt-figure"><Fit initial={620} max={700}>{(width) => <RhythmChart rhythm={state.rhythm} width={width} />}</Fit>
        <figcaption>一日精力曲线：灰底为通常的睡眠，色带为最佳时段，空心点为本人自评（高 / 中 / 低）</figcaption></figure>
      <RhythmStats rhythm={state.rhythm} />
      <p className="pt-credibility">{rhythmBasis(state.rhythm)} · {RHYTHM_CREDIBILITY}</p>
    </section>

    <section className="pt-page">
      <Heading number="02">价值与能量</Heading>
      <div className="pt-figure-row">
        {values ? <figure><Fit initial={300} max={340}>{(width) => <ValuesRadar values={values} size={width} />}</Fit><figcaption>价值取向：施瓦茨 10 项基本价值（0–100）</figcaption></figure> : null}
        <div className="pt-north"><small>正北</small><p className="gen">↑ {report.compass.trueNorth}</p></div>
      </div>
      <figure className="pt-figure"><Fit initial={520} max={680}>{(width) => <EnergyScatter map={report.energy.map} width={width} />}</Fit>
        <figcaption>能量地图：实心为充电，空心为耗电；右上为擅长且热爱</figcaption></figure>
    </section>

    <section className="pt-page">
      <Heading number="03">主线飞轮</Heading>
      <LineNetwork lines={ordered} edges={edges} title="主线之间如何互相供养" />
      {allLines.length > 0 && <figure className="pt-figure"><IdentityBars rows={allLines} /><figcaption>精力分配：实心为建议，空心标记为现在（%）</figcaption></figure>}
      <ul className="pt-goal-strip">{report.lines.items.map((item) => item.goals[0] ? <li key={item.lineId} data-line={item.lineId}><b>{name(item.lineId)}</b><span className="gen">{item.goals[0]}</span></li> : null)}</ul>
    </section>
  </>;
}

/** The four readings under the energy curve. */
const RhythmStats = ({ rhythm }: { rhythm: EnergyRhythm }) => <dl className="pt-rhythm-stats">{rhythmStats(rhythm).map((cell) =>
  <div key={cell.title}><dt>{cell.title}</dt><dd><b>{cell.value}</b><small>{cell.detail}</small></dd></div>)}</dl>;

/**
 * The portrait report (decided 2026-10-08, restructured the same day): the first half is the shareable portrait — type, labels, a few
 * lines and the figures — and ends with a share button; the second half is the personal detail and guidance, and ends with a share button
 * too. Both buttons share only the first half, from the redacted report: two 3:4 cards (1080×1440: the type, the energy rhythm) and
 * the half as one long image, through the system share sheet where the browser has one, downloaded otherwise.
 */
export function PortraitView({ initial, publicUrl, name }: { initial: State; publicUrl: string; name: string }) {
  const [state, setState] = useState(initial);
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState("");
  const sharedHalf = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const energyCard = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!publicUrl) return;
    void import("qrcode").then((QR) => QR.toDataURL(publicUrl, { margin: 1, width: 160 })).then(setQr).catch(() => setQr(""));
  }, [publicUrl]);
  // While the words are written, and for a while after while the figure is drawn, the page refreshes itself.
  const drawing = Boolean(state.report?.character) && !state.images.character && Boolean(state.at) && Date.now() - Date.parse(state.at!) < 20 * 60_000;
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
  const share = async () => {
    if (!sharedHalf.current || !card.current || !energyCard.current) return;
    setStatus("正在生成分享图片…");
    try {
      const { toBlob } = await import("html-to-image");
      const names = ["我的思维模式类型.png", "我的精力节律.png", "我的画像.png"];
      const blobs: Array<Blob | null> = [];
      for (const node of [card.current, energyCard.current, sharedHalf.current]) blobs.push(await toBlob(node, { pixelRatio: 2, backgroundColor: PAPER }));
      const files = blobs.flatMap((blob, index) => blob ? [new File([blob], names[index]!, { type: "image/png" })] : []);
      const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
      if (nav.canShare?.({ files })) await nav.share({ files, title: "我的 Crossline 画像" });
      else for (const file of files) { const link = document.createElement("a"); link.href = URL.createObjectURL(file); link.download = file.name; link.click(); }
      setStatus("");
    } catch (error) { setStatus(error instanceof DOMException && error.name === "AbortError" ? "" : "分享图片生成失败，请重试"); }
  };

  const raw = state.report;
  if (!raw) return <section className="pt-empty">
    {state.writing ? <p role="status">正在生成画像报告：读取访谈、画像与主线，通常需要几分钟…</p>
      : <><p>{state.blocker ? `上次未能生成：${state.blocker}` : "访谈结束后生成画像报告：前半部分为可分享的画像与图表，后半部分为个人细节与建议。"}</p>
        <button type="button" className="primary-button" onClick={() => void write()}>生成画像报告</button></>}
    {status && <small role="status">{status}</small>}
  </section>;
  const shared = redactPortrait(raw);
  const sharedType = portraitType(shared);
  const sharedLabels = portraitLabels(shared, { lineLabel: (id) => state.lines.find((line) => line.id === id)?.label ?? id });
  const lineById = new Map(state.lines.map((line) => [line.id, line]));
  const ordered = [...state.lines].sort((a, b) => (a.hard === b.hard ? 0 : a.hard ? -1 : 1) || (a.rank ?? 99) - (b.rank ?? 99));
  const date = (state.at ?? new Date().toISOString()).slice(0, 10);
  const footer = <footer className="pt-footer">
    <span>Crossline · 个人画像报告 · {date}{state.version > 1 ? ` · 第 ${state.version} 版` : ""}</span>
    {qr && <span className="pt-qr"><img src={qr} alt="Crossline 主页二维码" width={72} height={72} /><small>{publicUrl}</small></span>}
  </footer>;
  const shareBar = (where: string) => <div className="pt-share-bar" data-no-export="">
    <button type="button" className="primary-button" onClick={() => void share()}>分享画像</button>
    <small>{where}只分享前半部分：思维模式类型卡、精力节律卡与画像长图，人名、机构、课程编号等已隐去。</small>
    {status && <small role="status">{status}</small>}
  </div>;

  return <div className="pt-wrap">
    <div className="pt-toolbar" data-no-export="">
      <small className="muted">前半部分可分享；后半部分为个人细节与建议，仅自己可见</small>
      <button type="button" onClick={() => window.print()}>下载 PDF</button>
      <button type="button" disabled={state.writing} onClick={() => void write()}>{state.writing ? "重新生成中…" : "重新生成"}</button>
      {drawing && <small role="status">卡通形象生成中…</small>}
    </div>

    <div className="pt-doc">
      <SharePart report={raw} state={state} ordered={ordered} />
      {shareBar("")}

      <p className="pt-private" data-no-export="">以下为个人细节与建议，不包含在分享内容中</p>
      <section className="pt-page" data-private="">
        <h2><small>04</small>真问题</h2>
        <div className="pt-conflict"><small>核心矛盾</small><p className="gen">{raw.cover.coreConflict}</p></div>
        <p className="gen pt-lead">{raw.problem.statement}</p>
        <div className="pt-cols">
          <div className="pt-col" data-tone="gravity"><h3>需要接受的现实</h3><ul>{raw.problem.gravity.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>
          <div className="pt-col" data-tone="design"><h3>可以设计的问题</h3><ul>{raw.problem.designable.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>
        </div>
        <h3>思维误区 → 重新定义</h3>
        <div className="pt-reframes">{raw.problem.reframes.map((item) => <div key={item.fallacy} className="pt-reframe">
          <s className="gen">{item.fallacy}</s><span aria-hidden="true">→</span><p className="gen">{item.reframe}</p></div>)}</div>
        {footer}
      </section>

      <section className="pt-page" data-private="">
        <h2><small>05</small>指南针、能量与主线</h2>
        <div className="pt-compass">
          <div><small>工作观</small><p className="gen">{raw.compass.workView}</p></div>
          <div><small>人生观</small><p className="gen">{raw.compass.lifeView}</p></div>
          <div className="pt-span"><small>一致性</small><p className="gen">{raw.compass.consistency}</p></div>
        </div>
        <p className="gen pt-lead">{raw.energy.summary}</p>
        {raw.energy.flow.length > 0 && <div className="pt-flow"><small>心流时刻</small><ul>{raw.energy.flow.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>}
        <p className="gen pt-lead">{raw.lines.allocation}</p>
        <div className="pt-lines">{raw.lines.items.map((item) => { const line = lineById.get(item.lineId); return <article key={item.lineId} data-line={item.lineId}>
          <header><b>{line?.label ?? item.lineId}</b>{line && <small>{roleOf(line)}</small>}</header>
          <p className="gen">{item.description}</p>
          <ul className="pt-goals">{item.goals.map((goal) => <li key={goal} className="gen">{goal}</li>)}</ul>
          {item.feeds.length > 0 && <ul className="pt-feeds">{item.feeds.map((feed) => <li key={feed.toLineId}>→ {lineById.get(feed.toLineId)?.label ?? feed.toLineId}：<span className="gen">{feed.how}</span></li>)}</ul>}
        </article>; })}</div>
        {footer}
      </section>

      <section className="pt-page" data-private="">
        <h2><small>06</small>言行落差与锚</h2>
        <div className="pt-gap">
          <div><small>所说想要的</small><p className="gen">{raw.gap.says}</p></div>
          <span aria-hidden="true" className="pt-gap-sign">≠</span>
          <div><small>行为在维护的</small><p className="gen">{raw.gap.does}</p></div>
        </div>
        <h3 className="pt-serif">言行对照</h3>
        <figure className="pt-figure"><Fit initial={520} max={680}>{(width) => <GapChart pairs={raw.gap.pairs ?? []} sayDo={state.sayDo} width={width} />}</Fit></figure>
        <p className="gen pt-lead">{raw.gap.reading}</p>
        <ol className="pt-anchor">
          <li><small>锚</small><p className="gen">{raw.gap.anchor}</p></li>
          <li><small>背后真正想要的</small><p className="gen">{raw.gap.realWant}</p></li>
          <li><small>重新定义</small><p className="gen">{raw.gap.reframe}</p></li>
        </ol>
        {footer}
      </section>

      <section className="pt-page" data-private="">
        <h2><small>07</small>现况洞察与可行建议</h2>
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
        <h2><small>08</small>Crossline 下一步</h2>
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
      {shareBar("此按钮同样")}
    </div>

    {/* What is shared, rendered from the redacted report and never shown: the two 3:4 cards and the first half as one image. */}
    <div className="pt-offscreen" aria-hidden="true" data-no-export="">
      <div ref={card} className="pt-card" style={groupStyle(sharedType)}>
        <small className="pt-card-kicker">Crossline 思维模式类型{name ? ` · ${name}` : ""}</small>
        <div className="pt-card-head">
          <div className="pt-figure-disc"><Figure state={state} className="pt-card-figure" /></div>
          <div>{sharedType ? <>
            <p className="pt-type-code pt-serif">{sharedType.code}</p>
            <b className="pt-card-title pt-serif">{sharedType.name}</b>
          </> : <b className="pt-card-title gen">{shared.cover.archetype ?? "个人画像"}</b>}</div>
        </div>
        {shared.cover.tagline && <p className="pt-tagline gen">「{shared.cover.tagline}」</p>}
        {sharedType && <ul className="pt-card-axes">{sharedType.axes.map((axis) => <li key={axis.id}><b>{axis.percent}%</b> <span className="pt-serif">{axis.label}</span></li>)}</ul>}
        {sharedLabels.cells.length > 0 && <dl className="pt-card-labels">{sharedLabels.cells.map((cell) => <div key={cell.title}><dt>{cell.title}</dt>
          <dd className={cell.title === "核心词" ? "gen" : cell.title === "价值核心" ? "pt-serif" : undefined}>{cell.value}</dd></div>)}</dl>}
        {sharedLabels.identities.length > 0 && <div className="pt-card-identities"><small>身份</small><IdentityBars rows={sharedLabels.identities} /></div>}
        <small className="pt-card-foot">{CREDIBILITY} · Crossline{publicUrl ? ` · ${publicUrl}` : ""}</small>
      </div>
      <div ref={energyCard} className="pt-card pt-card-energy" style={groupStyle(sharedType)}>
        <small className="pt-card-kicker">Crossline 精力节律{name ? ` · ${name}` : ""}</small>
        <div className="pt-card-peak"><small>最佳时段</small><b>{rhythmStats(state.rhythm)[0]!.value}</b></div>
        <RhythmChart rhythm={state.rhythm} width={460} height={220} />
        <RhythmStats rhythm={state.rhythm} />
        <small className="pt-card-basis">{rhythmBasis(state.rhythm)}</small>
        <small className="pt-card-foot">{RHYTHM_CREDIBILITY} · Crossline{publicUrl ? ` · ${publicUrl}` : ""}</small>
      </div>
      <div ref={sharedHalf} className="pt-doc pt-shared-half"><SharePart report={shared} state={state} ordered={ordered} />{footer}<p className="pt-credibility">{CREDIBILITY}</p></div>
    </div>
  </div>;
}
