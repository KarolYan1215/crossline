"use client";

import { useEffect, useRef, useState } from "react";
import { redactPortrait, type PortraitReport } from "@crossline/core";

type Line = { id: string; label: string; rank: number | null; hard: boolean };
type State = {
  report: PortraitReport | null; version: number; at: string | null; writing: boolean; blocker: string | null; lines: Line[];
  next: { lines: Array<{ id: string; label: string; approved: string[]; drafts: string[] }>; hoursProposed: boolean; hoursSet: boolean };
};

const PRIORITY: Record<string, string> = { high: "优先", medium: "其次", low: "可缓" };
const roleOf = (line: Line) => line.hard ? "硬约束" : line.rank === 1 ? "底座" : line.rank ? `第 ${line.rank}` : "平行";

/** The lines as a flywheel: nodes on a circle in their order, an arrow for every way one line feeds another. */
function Flywheel({ lines, items }: { lines: Line[]; items: PortraitReport["lines"]["items"] }) {
  const size = 320, c = size / 2, r = lines.length > 1 ? 112 : 0;
  const at = new Map(lines.map((line, index) => {
    const angle = -Math.PI / 2 + (index / Math.max(1, lines.length)) * Math.PI * 2;
    return [line.id, { x: c + r * Math.cos(angle), y: c + r * Math.sin(angle) }];
  }));
  return <svg className="pt-flywheel" viewBox={`0 0 ${size} ${size}`} role="img" aria-label="主线飞轮：各主线如何互相供养">
    <defs><marker id="pt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="currentColor" /></marker></defs>
    <circle cx={c} cy={c} r={r} fill="none" stroke="currentColor" strokeOpacity=".12" strokeDasharray="3 5" />
    {items.flatMap((item) => item.feeds.map((feed) => {
      const a = at.get(item.lineId), b = at.get(feed.toLineId);
      if (!a || !b) return null;
      const mx = (a.x + b.x) / 2 + (c - (a.x + b.x) / 2) * 0.35, my = (a.y + b.y) / 2 + (c - (a.y + b.y) / 2) * 0.35;
      const shorten = (p: { x: number; y: number }, q: { x: number; y: number }) => { const d = Math.hypot(q.x - p.x, q.y - p.y) || 1; return { x: q.x - ((q.x - p.x) / d) * 34, y: q.y - ((q.y - p.y) / d) * 34 }; };
      const end = shorten({ x: mx, y: my }, b), start = shorten({ x: mx, y: my }, a);
      return <path key={`${item.lineId}>${feed.toLineId}`} d={`M${start.x},${start.y} Q${mx},${my} ${end.x},${end.y}`} fill="none" stroke="currentColor" strokeWidth="1.6"
        markerEnd="url(#pt-arrow)"><title>{feed.how}</title></path>;
    }))}
    {lines.map((line) => { const p = at.get(line.id)!; return <g key={line.id} data-line={line.id}>
      <circle cx={p.x} cy={p.y} r={30} style={{ fill: "var(--paper)", stroke: "var(--lc)" }} strokeWidth={line.rank === 1 || line.hard ? 4 : 2} />
      <text x={p.x} y={p.y + 4} textAnchor="middle" style={{ fill: "var(--lc)" }} fontSize="13" fontWeight="700">{line.label}</text>
      <text x={p.x} y={p.y + 46} textAnchor="middle" fontSize="11" fill="currentColor" opacity=".7">{roleOf(line)}</text>
    </g>; })}
  </svg>;
}

function Quadrants({ map }: { map: PortraitReport["energy"]["map"] }) {
  const cell = (skill: "high" | "low", love: "high" | "low", label: string) => <div className="pt-quad" data-q={`${skill}-${love}`}>
    <small>{label}</small>
    {map.filter((item) => item.skill === skill && item.love === love).map((item) => <span key={item.activity} data-charge={item.charge}>{item.charge === "charge" ? "＋" : "－"} {item.activity}</span>)}
  </div>;
  return <div className="pt-quads">
    <span className="pt-axis-y">热爱 ↑</span><span className="pt-axis-x">擅长 →</span>
    {cell("low", "high", "热爱 · 尚不擅长")}{cell("high", "high", "擅长且热爱")}{cell("low", "low", "既不擅长也不热爱")}{cell("high", "low", "擅长 · 不热爱")}
  </div>;
}

/**
 * The portrait report (decided 2026-10-08): an editorial A4 document in the app's own style. The first half — portrait and insight — is
 * what the shared version contains, with every sensitive span hidden; the second half — insights with advice, and what the app does
 * next — stays in the full version. Exported as a PDF (the browser's print, one A4 page per section) or a long PNG, with a QR code to the
 * public site at the end when one is configured.
 */
export function PortraitView({ initial, publicUrl, name }: { initial: State; publicUrl: string; name: string }) {
  const [state, setState] = useState(initial);
  const [mode, setMode] = useState<"full" | "share">("full");
  const [qr, setQr] = useState("");
  const [status, setStatus] = useState("");
  const doc = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!publicUrl) return;
    void import("qrcode").then((QR) => QR.toDataURL(publicUrl, { margin: 1, width: 160 })).then(setQr).catch(() => setQr(""));
  }, [publicUrl]);
  useEffect(() => {
    if (!state.writing) return;
    const timer = setInterval(() => void fetch("/api/portrait", { cache: "no-store" }).then((response) => response.json()).then((body: State) => setState(body)).catch(() => {}), 6000);
    return () => clearInterval(timer);
  }, [state.writing]);

  const write = async () => {
    setStatus("");
    const response = await fetch("/api/portrait", { method: "POST" }).catch(() => null);
    if (response?.ok) setState((current) => ({ ...current, writing: true, blocker: null })); else setStatus("未能开始生成，请稍后重试");
  };
  const png = async () => {
    if (!doc.current) return;
    setStatus("正在生成图片…");
    try {
      const { toPng } = await import("html-to-image");
      const url = await toPng(doc.current, { pixelRatio: 2, backgroundColor: "#ffffff", filter: (node) => !(node instanceof HTMLElement && node.dataset.noExport !== undefined) });
      const link = document.createElement("a");
      link.href = url; link.download = `画像报告${mode === "share" ? "-分享版" : ""}-v${state.version}.png`; link.click();
      setStatus("");
    } catch { setStatus("图片生成失败，可改用下载 PDF"); }
  };

  const raw = state.report;
  if (!raw) return <section className="pt-empty">
    {state.writing ? <p role="status">正在生成画像报告：读取访谈、画像与主线，通常需要几分钟…</p>
      : <><p>{state.blocker ? `上次未能生成：${state.blocker}` : "访谈结束后生成画像报告：个人画像与洞察（可分享）、现况洞察与可行建议（仅自己可见）。"}</p>
        <button type="button" className="primary-button" onClick={() => void write()}>生成画像报告</button></>}
    {status && <small role="status">{status}</small>}
  </section>;
  const report = mode === "share" ? redactPortrait(raw) : raw;
  const lineById = new Map(state.lines.map((line) => [line.id, line]));
  const ordered = [...state.lines].sort((a, b) => (a.hard === b.hard ? 0 : a.hard ? -1 : 1) || (a.rank ?? 99) - (b.rank ?? 99));
  const date = (state.at ?? new Date().toISOString()).slice(0, 10);
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
      <button type="button" onClick={() => void png()}>下载图片</button>
      <button type="button" disabled={state.writing} onClick={() => void write()}>{state.writing ? "重新生成中…" : "重新生成"}</button>
      {status && <small role="status">{status}</small>}
    </div>

    <div className="pt-doc" ref={doc}>
      <section className="pt-page pt-cover">
        <p className="pt-kicker">个人画像报告{name && mode === "full" ? ` · ${name}` : ""}</p>
        <h1 className="gen">{report.cover.portrait}</h1>
        <div className="pt-conflict"><small>核心矛盾</small><p className="gen">{report.cover.coreConflict}</p></div>
        <p className="pt-keywords">{report.cover.keywords.map((word) => <span key={word} className="tag">{word}</span>)}</p>
        <ol className="pt-line-strip">{ordered.map((line) => <li key={line.id} data-line={line.id}><b>{line.label}</b><small>{roleOf(line)}</small></li>)}</ol>
        {footer}
      </section>

      <section className="pt-page">
        <h2><small>01</small>真问题</h2>
        <p className="gen pt-lead">{report.problem.statement}</p>
        <div className="pt-cols">
          <div className="pt-col" data-tone="gravity"><h3>需要接受的现实</h3><ul>{report.problem.gravity.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>
          <div className="pt-col" data-tone="design"><h3>可以设计的问题</h3><ul>{report.problem.designable.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>
        </div>
        <h3>思维误区 → 重新定义</h3>
        <div className="pt-reframes">{report.problem.reframes.map((item) => <div key={item.fallacy} className="pt-reframe">
          <s className="gen">{item.fallacy}</s><span aria-hidden="true">→</span><p className="gen">{item.reframe}</p></div>)}</div>
        {footer}
      </section>

      <section className="pt-page">
        <h2><small>02</small>指南针与能量地图</h2>
        <div className="pt-compass">
          <div><small>工作观</small><p className="gen">{report.compass.workView}</p></div>
          <div><small>人生观</small><p className="gen">{report.compass.lifeView}</p></div>
          <div className="pt-span"><small>一致性</small><p className="gen">{report.compass.consistency}</p></div>
          <div className="pt-span pt-north"><small>正北</small><p className="gen">↑ {report.compass.trueNorth}</p></div>
        </div>
        <Quadrants map={report.energy.map} />
        <p className="gen pt-lead">{report.energy.summary}</p>
        {report.energy.flow.length > 0 && <div className="pt-flow"><small>心流时刻</small><ul>{report.energy.flow.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>}
        {footer}
      </section>

      <section className="pt-page">
        <h2><small>03</small>主线飞轮与长期目标</h2>
        <div className="pt-fly">
          <Flywheel lines={ordered} items={report.lines.items} />
          <p className="gen pt-lead">{report.lines.allocation}</p>
        </div>
        <div className="pt-lines">{report.lines.items.map((item) => { const line = lineById.get(item.lineId); return <article key={item.lineId} data-line={item.lineId}>
          <header><b>{line?.label ?? item.lineId}</b>{line && <small>{roleOf(line)}</small>}</header>
          <p className="gen">{item.description}</p>
          <ul className="pt-goals">{item.goals.map((goal) => <li key={goal} className="gen">{goal}</li>)}</ul>
          {item.feeds.length > 0 && <ul className="pt-feeds">{item.feeds.map((feed) => <li key={feed.toLineId}>→ {lineById.get(feed.toLineId)?.label ?? feed.toLineId}：<span className="gen">{feed.how}</span></li>)}</ul>}
        </article>; })}</div>
        {footer}
      </section>

      <section className="pt-page">
        <h2><small>04</small>言行落差与锚</h2>
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
          <ol className="pt-insights">{raw.insights.map((item, index) => <li key={index} data-priority={item.priority}>
            <header><span className="tag">{PRIORITY[item.priority]}</span><small>解决：<span className="gen">{item.solves}</span></small></header>
            <p className="gen pt-insight">{item.insight}</p>
            <p className="gen"><b>建议</b> {item.advice}</p>
          </li>)}</ol>
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
  </div>;
}
