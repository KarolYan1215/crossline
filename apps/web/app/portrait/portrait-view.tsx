"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Download, Lock, PenLine, RefreshCw, Share2, UserRound } from "lucide-react";
import { IconButton } from "../ui/icon-button";
import { portraitLabels, portraitType, redactPortrait, type EnergyRhythm, type PortraitReport, type PortraitType, type SayDoReading } from "@crossline/core";
import { LineNetwork, type NetworkEdge } from "../ui/line-network";
import { FigurePicker } from "./figure-picker";
import { AdviceMatrix, DivergingAxes, EnergyScatter, Fit, GapChart, IdentityBars, RhythmChart, ValuesRadar } from "./portrait-charts";
import { radarValues, rhythmStats } from "./poster-geometry";
import { joinList, type Locale, type Translate } from "../../lib/i18n";
import { useLocale, useT } from "../locale-context";

type Line = { id: string; label: string; rank: number | null; hard: boolean };
type State = {
  report: PortraitReport | null; version: number; at: string | null; writing: boolean; blocker: string | null; lines: Line[];
  images: Record<string, string>; sayDo: SayDoReading; rhythm: EnergyRhythm;
  next: { lines: Array<{ id: string; label: string; approved: string[]; drafts: string[] }>; hoursProposed: boolean; hoursSet: boolean };
  confirmation: { written: boolean; confirmed: boolean; at: string | null };
  appearance: { text: string; skipped: boolean };
};
const ICON = { size: 17, strokeWidth: 1.75, "aria-hidden": true } as const;

/** The report's contents in two groups: what is shared, then what only the person sees (2026-10-28 redesign). */
const SHARED_SECTIONS = [["type", "超级个体类型"], ["rhythm", "精力节律"], ["values", "价值与能量"], ["lines", "主线飞轮"]] as const;
const PRIVATE_SECTIONS = [["problem", "真问题"], ["compass", "指南针、能量与主线"], ["gap", "言行落差与锚"], ["insights", "现况洞察与可行建议"], ["next", "Crossline 下一步"]] as const;

/** The contents beside the report, the section in view marked. */
function Contents() {
  const t = useT();
  const [current, setCurrent] = useState("type");
  useEffect(() => {
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setCurrent(visible.target.id.replace(/^pt-s-/, ""));
    }, { rootMargin: "-15% 0px -70% 0px" });
    for (const [id] of [...SHARED_SECTIONS, ...PRIVATE_SECTIONS]) { const element = document.getElementById(`pt-s-${id}`); if (element) observer.observe(element); }
    return () => observer.disconnect();
  }, []);
  const link = ([id, label]: readonly [string, string]) => <a key={id} href={`#pt-s-${id}`} aria-current={current === id ? "true" : undefined}>{t(label)}</a>;
  return <nav className="pt-toc" aria-label={t("画像目录")}>
    <p className="pt-toc-group"><Share2 {...ICON} size={14} />{t("可分享")}</p>
    {SHARED_SECTIONS.map(link)}
    <small className="pt-toc-note">{t("分享只含这一组；人名、机构、课程编号已隐去")}</small>
    <p className="pt-toc-group"><Lock {...ICON} size={14} />{t("仅自己可见")}</p>
    {PRIVATE_SECTIONS.map(link)}
  </nav>;
}

/**
 * 「这份画像符合本人吗？」 (2026-10-28, scenarios.md §3-10): asked here, where the portrait is read, and no longer in the interview, which
 * links here. 符合 confirms it as the interview's own question did; 大体符合 and 不符合 take a sentence and go to the interview, which
 * rewrites the portrait from it.
 */
function ConfirmBar({ confirmation, onAnswered }: { confirmation: State["confirmation"]; onAnswered: (next: Partial<State>) => void }) {
  const t = useT();
  const [answer, setAnswer] = useState<"" | "mostly" | "no">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState("");
  const send = async (choice: "yes" | "mostly" | "no") => {
    setBusy(true); setSaid("");
    const response = await fetch("/api/portrait/confirm", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ answer: choice, note: choice === "yes" ? "" : note }) }).catch(() => null);
    const body = await response?.json().catch(() => null) as { ok?: boolean; message?: string } | null;
    setBusy(false);
    if (!body?.ok) { setSaid(body?.message ?? t("没有保存，请重试")); return; }
    setSaid(body.message ?? "");
    if (choice === "yes") onAnswered({ confirmation: { ...confirmation, confirmed: true, at: new Date().toISOString() } });
    else { setAnswer(""); setNote(""); onAnswered({ writing: true }); }
  };
  if (confirmation.confirmed) return <div className="pt-confirm" data-no-export="" data-state="done">
    <Check {...ICON} /><span>{t("本人已确认这份画像符合自己")}</span>
    <button type="button" className="text-button" onClick={() => setAnswer("mostly")}>{t("有地方要改")}</button>
    {answer && <ConfirmNote answer={answer} note={note} busy={busy} onNote={setNote} onSend={() => void send(answer)} onCancel={() => setAnswer("")} />}
    {said && <small role="status">{said}</small>}
  </div>;
  return <div className="pt-confirm" data-no-export="" role="group" aria-label={t("这份画像符合本人吗？")}>
    <b>{t("这份画像符合本人吗？")}</b><small>{t("读完再选；确认后访谈不再问这一题")}</small>
    <span className="pt-confirm-actions">
      <button type="button" className="primary-button" disabled={busy} onClick={() => void send("yes")}><Check {...ICON} />{t("符合")}</button>
      <button type="button" className="secondary-button" disabled={busy} aria-pressed={answer === "mostly"} onClick={() => setAnswer("mostly")}>{t("大体符合")}</button>
      <button type="button" className="text-button" disabled={busy} aria-pressed={answer === "no"} onClick={() => setAnswer("no")}><PenLine {...ICON} />{t("不符合，说说哪里")}</button>
    </span>
    {answer && <ConfirmNote answer={answer} note={note} busy={busy} onNote={setNote} onSend={() => void send(answer)} onCancel={() => setAnswer("")} />}
    {said && <small role="status">{said}</small>}
  </div>;
}

function ConfirmNote({ answer, note, busy, onNote, onSend, onCancel }: { answer: "mostly" | "no"; note: string; busy: boolean;
  onNote: (text: string) => void; onSend: () => void; onCancel: () => void }) {
  const t = useT();
  return <form className="pt-confirm-note" onSubmit={(event) => { event.preventDefault(); if (note.trim()) onSend(); }}>
    <textarea value={note} rows={2} maxLength={1000} onChange={(event) => onNote(event.target.value)} aria-label={t("哪里要改")}
      placeholder={answer === "mostly" ? t("例如：第二句里的“…”要改成…") : t("哪里不对，实际是怎样")} />
    <span><button type="submit" className="primary-button" disabled={busy || !note.trim()}>{t("交给访谈修改")}</button>
      <button type="button" className="text-button" onClick={onCancel}>{t("取消")}</button></span>
  </form>;
}

const PRIORITY: Record<string, string> = { high: "优先", medium: "其次", low: "可缓" };
/** On the share card and the long image (decided 2026-10-12): what the portrait is, against the Barnum effect. */
const CREDIBILITY = "基于访谈的推断，不是标准化心理测验";
/** Under the energy curve: what it is. */
const RHYTHM_CREDIBILITY = "按睡眠记录与自评校准的模型估计，非医学诊断";
const groupStyle = (type: PortraitType | null) => type ? { ["--group" as string]: type.group.colour, ["--group-tint" as string]: type.group.tint } : undefined;
/** What the curve rests on, in one line. */
const rhythmBasis = (rhythm: EnergyRhythm, t: Translate) => rhythm.nights
  ? rhythm.reports.length ? t("依据近四周 {{nights}} 晚睡眠记录与 {{reports}} 次自评；三过程模型（Åkerstedt 等，2004）", { nights: rhythm.nights, reports: rhythm.reports.length })
    : t("依据近四周 {{nights}} 晚睡眠记录；三过程模型（Åkerstedt 等，2004）", { nights: rhythm.nights })
  : t("尚无睡眠记录：按 23:30–7:30 的通用作息画出；三过程模型（Åkerstedt 等，2004）");
/** The paper colour of style A, also the background of the exported images. */
const PAPER = "#F6F2EA";
const roleOf = (line: Line, t: Translate) => line.hard ? t("硬约束") : line.rank === 1 ? t("底座") : line.rank ? t("第 {{rank}}", { rank: line.rank }) : t("平行");

/** The report's line-to-line feeds as the shared network. */
const edgesOf = (report: PortraitReport): NetworkEdge[] => report.lines.items.flatMap((item) => item.feeds.map((feed, index) => ({
  id: `${item.lineId}>${feed.toLineId}:${index}`, from: item.lineId, to: feed.toLineId, kind: "", explanation: feed.how, status: "confirmed" as const })));

/** The person's cartoon figure (the one they picked, else the latest drawn), when there is one. */
function Figure({ state, className }: { state: State; className: string }) {
  const t = useT();
  const src = state.images.character;
  return src ? <img className={className} src={src} alt={t("代表这一类型的卡通形象")} /> : null;
}

/** A hard-coded section title, set in the poster's serif, with its number. */
const Heading = ({ number, children }: { number: string; children: string }) => <h2><small>{number}</small><span className="pt-serif">{children}</span></h2>;

/** How a label cell is set: the writer's core word in the model's face, the top Schwartz value (a fixed name) in the poster's serif. */
const cellClass = (cell: { title: string }, t: Translate) => cell.title === t("核心词") ? "gen" : cell.title === t("价值核心") ? "pt-serif" : undefined;

/** The type's closing sentence after the writer's summary, 「…，你是某神秘光头。」, in the page's language. */
function summaryWithType(summary: string, type: PortraitType, t: Translate, locale: Locale) {
  const text = summary.replace(/[，,。.；;、\s]+$/u, "");
  const closing = t("你是{{name}}。", { name: t(type.name) });
  return locale === "en" ? <><span className="gen">{text}.</span> {closing}</> : <><span className="gen">{text}，</span>{closing}</>;
}

/**
 * The shareable half in style A 「编辑杂志」 (decided 2026-10-12; reordered 2026-10-14, docs/energy-and-ecosystem.md §7): the type as a
 * result page (figure on a disc of the group's colour, code, name, group), the one-line tagline, the four axes as diverging bars with
 * their reasons, the labels computed in code with the other lines as identity bars; then the energy rhythm, the values and energy map,
 * and the lines as a flywheel. The core conflict and the say–do comparison are private. Rendered twice — from the person's own report on
 * screen and from the redacted report off screen — and only the second is ever exported.
 */
function SharePart({ report, state, ordered, anchors = false, afterType = null }: { report: PortraitReport; state: State; ordered: Line[];
  /** On screen only: the sections carry the ids the contents link to (the off-screen copy must not repeat them). */
  anchors?: boolean;
  /** Shown after the type page on screen (the confirmation), never exported. */
  afterType?: ReactNode }) {
  const id = (name: string) => anchors ? { id: `pt-s-${name}` } : {};
  const t = useT();
  const locale = useLocale();
  const type = portraitType(report);
  const name = (id: string) => state.lines.find((line) => line.id === id)?.label ?? id;
  // Labels come back in the page's language (`portraitLabels` translates titles, the value and the base's detail).
  const { cells, identities } = portraitLabels(report, { lineLabel: name, locale });
  const edges = edgesOf(report);
  const allLines = [...report.lines.items].sort((a, b) => (b.targetShare ?? 0) - (a.targetShare ?? 0))
    .flatMap((item) => item.targetShare === undefined ? [] : [{ lineId: item.lineId, label: name(item.lineId), target: item.targetShare, now: item.share ?? null }]);
  const values = radarValues(report.compass.values);
  return <>
    <section className="pt-page pt-type" style={groupStyle(type)} {...id("type")}>
      <header className="pt-poster-head"><p className="pt-kicker">{t("Crossline · AI 时代超级个体类型")}</p><p className="pt-credibility">{t(CREDIBILITY)}</p></header>
      <div className="pt-type-head">
        <div className="pt-figure-disc"><Figure state={state} className="pt-figure-img" /></div>
        <div className="pt-type-id">
          {type ? <>
            <h1 className="pt-type-name pt-serif">{t(type.name)}</h1>
            <p className="pt-type-quote pt-serif">{t("「{{quote}}」", { quote: t(type.quote) })}</p>
            <p className="pt-type-group"><span><b className="pt-serif">{t(type.group.name)}</b> · {t(type.group.blurb)}</span></p>
            {/* The writer's paragraph to the person, ended in code with the type the scores make, so the two never disagree. */}
            <p className="pt-type-blurb" data-reading="">{type.summary ? summaryWithType(type.summary, type, t, locale) : t(type.blurb)}</p>
          </> : <h1 className="pt-type-name gen">{report.cover.archetype ?? report.cover.keywords[0] ?? t("个人画像")}</h1>}
        </div>
      </div>
      {report.cover.tagline && <p className="pt-tagline gen">{t("「{{tagline}}」", { tagline: report.cover.tagline })}</p>}
      {type && <DivergingAxes type={type} evidence />}
      {(cells.length > 0 || identities.length > 0) && <dl className="pt-labels">
        {cells.map((cell) => <div key={cell.title}><dt>{cell.title}</dt>
          <dd><b className={cellClass(cell, t)}>{cell.value}</b>{cell.detail && <small>{cell.detail}</small>}</dd></div>)}
        {identities.length > 0 && <div className="pt-labels-wide"><dt>{t("身份")}</dt><dd><IdentityBars rows={identities} /></dd></div>}
      </dl>}
      <div className="pt-summary">
        <p className="gen pt-lead">{report.cover.portrait}</p>
        <p className="pt-keywords">{report.cover.keywords.map((word) => <span key={word} className="tag gen">{word}</span>)}</p>
      </div>
    </section>
    {afterType}

    <section className="pt-page" style={groupStyle(type)} {...id("rhythm")}>
      <Heading number="01">{t("精力节律")}</Heading>
      <figure className="pt-figure"><Fit initial={620} max={700}>{(width) => <RhythmChart rhythm={state.rhythm} width={width} />}</Fit>
        <figcaption>{t("一日精力曲线：灰底为通常的睡眠，色带为最佳时段，空心点为本人自评（高 / 中 / 低）")}</figcaption></figure>
      <RhythmStats rhythm={state.rhythm} />
      <p className="pt-credibility">{rhythmBasis(state.rhythm, t)} · {t(RHYTHM_CREDIBILITY)}</p>
    </section>

    <section className="pt-page" {...id("values")}>
      <Heading number="02">{t("价值与能量")}</Heading>
      <div className="pt-figure-row">
        {values ? <figure><Fit initial={300} max={340}>{(width) => <ValuesRadar values={values} size={width} />}</Fit><figcaption>{t("价值取向：施瓦茨 10 项基本价值（0–100）")}</figcaption></figure> : null}
        <div className="pt-north"><small>{t("正北")}</small><p className="gen">↑ {report.compass.trueNorth}</p></div>
      </div>
      <figure className="pt-figure"><Fit initial={520} max={680}>{(width) => <EnergyScatter map={report.energy.map} width={width} />}</Fit>
        <figcaption>{t("能量地图：实心为充电，空心为耗电；右上为擅长且热爱")}</figcaption></figure>
    </section>

    <section className="pt-page" {...id("lines")}>
      <Heading number="03">{t("主线飞轮")}</Heading>
      <LineNetwork lines={ordered} edges={edges} title={t("主线之间如何互相供养")} />
      {allLines.length > 0 && <figure className="pt-figure"><IdentityBars rows={allLines} /><figcaption>{t("精力分配：实心为建议，空心标记为现在（%）")}</figcaption></figure>}
      <ul className="pt-goal-strip">{report.lines.items.map((item) => item.goals[0] ? <li key={item.lineId} data-line={item.lineId}><b>{name(item.lineId)}</b><span className="gen">{item.goals[0]}</span></li> : null)}</ul>
    </section>
  </>;
}

/** The four readings under the energy curve. */
function RhythmStats({ rhythm }: { rhythm: EnergyRhythm }) {
  return <dl className="pt-rhythm-stats">{rhythmStats(rhythm, useLocale()).map((cell) =>
    <div key={cell.title}><dt>{cell.title}</dt><dd><b>{cell.value}</b><small>{cell.detail}</small></dd></div>)}</dl>;
}

/**
 * The portrait report (decided 2026-10-08, restructured the same day): the first half is the shareable portrait — type, labels, a few
 * lines and the figures — and ends with a share button; the second half is the personal detail and guidance, and ends with a share button
 * too. Both buttons share only the first half, from the redacted report: two 3:4 cards (1080×1440: the type, the energy rhythm) and
 * the half as one long image, through the system share sheet where the browser has one, downloaded otherwise.
 */
export function PortraitView({ initial, publicUrl, name }: { initial: State; publicUrl: string; name: string }) {
  const t = useT();
  const locale = useLocale();
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

  // The picker says which figure is now the person's; the page shows that one at once.
  const showFigure = useCallback((url: string | null) => setState((current) => {
    const images = { ...current.images };
    if (url) images.character = url; else delete images.character;
    return images.character === current.images.character ? current : { ...current, images };
  }), []);
  const write = async () => {
    setStatus("");
    const response = await fetch("/api/portrait", { method: "POST" }).catch(() => null);
    if (response?.ok) setState((current) => ({ ...current, writing: true, blocker: null })); else setStatus(t("未能开始生成，请稍后重试"));
  };
  const share = async () => {
    if (!sharedHalf.current || !card.current || !energyCard.current) return;
    setStatus(t("正在生成分享图片…"));
    try {
      const { toBlob } = await import("html-to-image");
      const names = [t("我的超级个体类型.png"), t("我的精力节律.png"), t("我的画像.png")];
      const blobs: Array<Blob | null> = [];
      for (const node of [card.current, energyCard.current, sharedHalf.current]) blobs.push(await toBlob(node, { pixelRatio: 2, backgroundColor: PAPER }));
      const files = blobs.flatMap((blob, index) => blob ? [new File([blob], names[index]!, { type: "image/png" })] : []);
      const nav = navigator as Navigator & { canShare?: (data: { files: File[] }) => boolean };
      if (nav.canShare?.({ files })) await nav.share({ files, title: t("我的 Crossline 画像") });
      else for (const file of files) { const link = document.createElement("a"); link.href = URL.createObjectURL(file); link.download = file.name; link.click(); }
      setStatus("");
    } catch (error) { setStatus(error instanceof DOMException && error.name === "AbortError" ? "" : t("分享图片生成失败，请重试")); }
  };

  const raw = state.report;
  const generated = state.at ? state.version > 1 ? t("{{date}} 生成 · 第 {{version}} 版", { date: state.at.slice(5, 10).replace("-", "/"), version: state.version })
    : t("{{date}} 生成", { date: state.at.slice(5, 10).replace("-", "/") }) : "";
  const head = (actions: boolean) => <header className="subpage-header pt-head" data-no-export="">
    <div><h1>{t("画像")}</h1><p className="muted">{[t(CREDIBILITY), generated].filter(Boolean).join(" · ")}</p></div>
    <div className="pt-actions">
      {status && <small role="status">{status}</small>}
      {drawing && <small role="status">{t("卡通形象生成中…")}</small>}
      {actions && <>
        <button type="button" className="primary-button pt-share" onClick={() => void share()}><Share2 {...ICON} /><span>{t("分享前半部分")}</span></button>
        <IconButton label={t("下载 PDF")} icon={<Download {...ICON} />} onClick={() => window.print()} />
        <IconButton label={t("小帮手形象")} icon={<UserRound {...ICON} />} onClick={() => document.getElementById("pt-figure-card")?.scrollIntoView({ block: "start", behavior: "smooth" })} />
        <IconButton label={state.writing ? t("重新生成中…") : t("重新生成")} icon={<RefreshCw {...ICON} />} disabled={state.writing} onClick={() => void write()} />
      </>}
    </div>
  </header>;
  // Before a report exists: what it will hold, and the one button that writes it.
  if (!raw) return <div className="pt-wrap">
    {head(false)}
    <section className="pt-empty">
      {state.writing ? <p role="status">{t("正在生成画像报告：读取访谈、画像与主线，通常需要几分钟…")}</p>
        : <><p>{state.blocker ? t("上次未能生成：{{reason}}", { reason: state.blocker }) : t("访谈结束后生成画像报告：前半部分为可分享的画像与图表，后半部分为个人细节与建议。")}</p>
          <ul className="pt-empty-list"><li>{t("可分享：超级个体类型、精力节律、价值与能量、主线飞轮")}</li><li>{t("仅自己可见：真问题、指南针、言行落差与锚、建议、下一步")}</li></ul>
          <button type="button" className="primary-button" onClick={() => void write()}>{t("生成画像报告")}</button></>}
    </section>
    <FigurePicker onCurrent={showFigure} appearance={state.appearance} />
  </div>;
  const shared = redactPortrait(raw);
  const sharedType = portraitType(shared);
  const sharedLabels = portraitLabels(shared, { lineLabel: (id) => state.lines.find((line) => line.id === id)?.label ?? id, locale });
  const lineById = new Map(state.lines.map((line) => [line.id, line]));
  const ordered = [...state.lines].sort((a, b) => (a.hard === b.hard ? 0 : a.hard ? -1 : 1) || (a.rank ?? 99) - (b.rank ?? 99));
  const date = (state.at ?? new Date().toISOString()).slice(0, 10);
  const footer = <footer className="pt-footer">
    <span>{state.version > 1 ? t("Crossline · 个人画像报告 · {{date}} · 第 {{version}} 版", { date, version: state.version }) : t("Crossline · 个人画像报告 · {{date}}", { date })}</span>
    {qr && <span className="pt-qr"><img src={qr} alt={t("Crossline 主页二维码")} width={72} height={72} /><small>{publicUrl}</small></span>}
  </footer>;
  return <div className="pt-wrap">
    {head(true)}
    <div className="pt-layout">
      <aside className="pt-side" data-no-export="">
        <Contents />
        <FigurePicker onCurrent={showFigure} appearance={state.appearance} />
      </aside>
    <div className="pt-doc">
      <SharePart report={raw} state={state} ordered={ordered} anchors
        afterType={state.confirmation.written ? <ConfirmBar confirmation={state.confirmation} onAnswered={(next) => setState((current) => ({ ...current, ...next }))} /> : null} />

      <p className="pt-private" data-no-export="">{t("以下为个人细节与建议，不包含在分享内容中")}</p>
      <section className="pt-page" data-private="" id="pt-s-problem">
        <h2><small>04</small>{t("真问题")}</h2>
        <div className="pt-conflict"><small>{t("核心矛盾")}</small><p className="gen">{raw.cover.coreConflict}</p></div>
        <p className="gen pt-lead">{raw.problem.statement}</p>
        <div className="pt-cols">
          <div className="pt-col" data-tone="gravity"><h3>{t("需要接受的现实")}</h3><ul>{raw.problem.gravity.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>
          <div className="pt-col" data-tone="design"><h3>{t("可以设计的问题")}</h3><ul>{raw.problem.designable.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>
        </div>
        <h3>{t("思维误区 → 重新定义")}</h3>
        <div className="pt-reframes">{raw.problem.reframes.map((item) => <div key={item.fallacy} className="pt-reframe">
          <s className="gen">{item.fallacy}</s><span aria-hidden="true">→</span><p className="gen">{item.reframe}</p></div>)}</div>
        {footer}
      </section>

      <section className="pt-page" data-private="" id="pt-s-compass">
        <h2><small>05</small>{t("指南针、能量与主线")}</h2>
        <div className="pt-compass">
          <div><small>{t("工作观")}</small><p className="gen">{raw.compass.workView}</p></div>
          <div><small>{t("人生观")}</small><p className="gen">{raw.compass.lifeView}</p></div>
          <div className="pt-span"><small>{t("一致性")}</small><p className="gen">{raw.compass.consistency}</p></div>
        </div>
        <p className="gen pt-lead">{raw.energy.summary}</p>
        {raw.energy.flow.length > 0 && <div className="pt-flow"><small>{t("心流时刻")}</small><ul>{raw.energy.flow.map((item) => <li key={item} className="gen">{item}</li>)}</ul></div>}
        <p className="gen pt-lead">{raw.lines.allocation}</p>
        <div className="pt-lines">{raw.lines.items.map((item) => { const line = lineById.get(item.lineId); return <article key={item.lineId} data-line={item.lineId}>
          <header><b>{line?.label ?? item.lineId}</b>{line && <small>{roleOf(line, t)}</small>}</header>
          <p className="gen">{item.description}</p>
          <ul className="pt-goals">{item.goals.map((goal) => <li key={goal} className="gen">{goal}</li>)}</ul>
          {item.feeds.length > 0 && <ul className="pt-feeds">{item.feeds.map((feed) => <li key={feed.toLineId}>{t("→ {{line}}：", { line: lineById.get(feed.toLineId)?.label ?? feed.toLineId })}<span className="gen">{feed.how}</span></li>)}</ul>}
        </article>; })}</div>
        {footer}
      </section>

      <section className="pt-page" data-private="" id="pt-s-gap">
        <h2><small>06</small>{t("言行落差与锚")}</h2>
        <div className="pt-gap">
          <div><small>{t("所说想要的")}</small><p className="gen">{raw.gap.says}</p></div>
          <span aria-hidden="true" className="pt-gap-sign">≠</span>
          <div><small>{t("行为在维护的")}</small><p className="gen">{raw.gap.does}</p></div>
        </div>
        <h3 className="pt-serif">{t("言行对照")}</h3>
        <figure className="pt-figure"><Fit initial={520} max={680}>{(width) => <GapChart pairs={raw.gap.pairs ?? []} sayDo={state.sayDo} width={width} />}</Fit></figure>
        <p className="gen pt-lead">{raw.gap.reading}</p>
        <ol className="pt-anchor">
          <li><small>{t("锚")}</small><p className="gen">{raw.gap.anchor}</p></li>
          <li><small>{t("背后真正想要的")}</small><p className="gen">{raw.gap.realWant}</p></li>
          <li><small>{t("重新定义")}</small><p className="gen">{raw.gap.reframe}</p></li>
        </ol>
        {footer}
      </section>

      <section className="pt-page" data-private="" id="pt-s-insights">
        <h2><small>07</small>{t("现况洞察与可行建议")}</h2>
        <div className="pt-figure-row">
          <AdviceMatrix insights={raw.insights} />
          <ol className="pt-insights">{raw.insights.map((item, index) => <li key={index} data-priority={item.priority}>
            <header><span className="pt-num mono">{index + 1}</span><span className="tag">{t(PRIORITY[item.priority] ?? "")}</span><small>{t("解决：")}<span className="gen">{item.solves}</span></small></header>
            <p className="gen pt-insight">{item.insight}</p>
            <p className="gen"><b>{t("建议")}</b> {item.advice}</p>
          </li>)}</ol>
        </div>
        {footer}
      </section>
      <section className="pt-page" data-private="" id="pt-s-next">
        <h2><small>08</small>{t("Crossline 下一步")}</h2>
        <ol className="pt-next">
          <li data-done={state.next.hoursSet || undefined}><b>{t("确认可用时段")}</b><span>{state.next.hoursSet ? t("已设定") : state.next.hoursProposed ? t("访谈已提议，在计划页预览后采用") : t("在计划页设定工作时段")}</span></li>
          {state.next.lines.map((line) => <li key={line.id} data-line={line.id} data-done={line.approved.length > 0 || undefined}>
            <b>{t("{{line}} · 里程碑", { line: line.label })}</b>
            <span>{line.approved.length ? t("已批准 {{count}} 个：{{titles}}", { count: line.approved.length, titles: joinList(locale, line.approved.slice(0, 3)) })
              : line.drafts.length ? t("{{count}} 个草稿待批准", { count: line.drafts.length }) : t("尚未设计，可在访谈页生成草稿")}</span>
          </li>)}
          <li><b>{t("任务与日程")}</b><span>{t("里程碑批准后自动倒推任务；任务拆成步骤，排进可用时段，硬约束的固定日程为骨架。")}</span></li>
        </ol>
        {footer}
      </section>
    </div>
    </div>

    {/* What is shared, rendered from the redacted report and never shown: the two 3:4 cards and the first half as one image. */}
    <div className="pt-offscreen" aria-hidden="true" data-no-export="">
      <div ref={card} className="pt-card" style={groupStyle(sharedType)}>
        <small className="pt-card-kicker">{t("Crossline · AI 时代超级个体类型")}{name ? ` · ${name}` : ""}</small>
        <div className="pt-card-head">
          <div className="pt-figure-disc"><Figure state={state} className="pt-card-figure" /></div>
          <div>{sharedType ? <>
            <b className="pt-card-title pt-serif">{t(sharedType.name)}</b>
            <p className="pt-type-quote pt-serif">{t("「{{quote}}」", { quote: t(sharedType.quote) })}</p>
          </> : <b className="pt-card-title gen">{shared.cover.archetype ?? t("个人画像")}</b>}</div>
        </div>
        {shared.cover.tagline && <p className="pt-tagline gen">{t("「{{tagline}}」", { tagline: shared.cover.tagline })}</p>}
        {sharedType && <ul className="pt-card-axes">{sharedType.axes.map((axis) => <li key={axis.id}><b>{axis.percent}%</b> <span className="pt-serif">{t(axis.label)}</span></li>)}</ul>}
        {sharedLabels.cells.length > 0 && <dl className="pt-card-labels">{sharedLabels.cells.map((cell) => <div key={cell.title}><dt>{cell.title}</dt>
          <dd className={cellClass(cell, t)}>{cell.value}</dd></div>)}</dl>}
        {sharedLabels.identities.length > 0 && <div className="pt-card-identities"><small>{t("身份")}</small><IdentityBars rows={sharedLabels.identities} /></div>}
        <small className="pt-card-foot">{t(CREDIBILITY)} · Crossline{publicUrl ? ` · ${publicUrl}` : ""}</small>
      </div>
      <div ref={energyCard} className="pt-card pt-card-energy" style={groupStyle(sharedType)}>
        <small className="pt-card-kicker">{t("Crossline 精力节律")}{name ? ` · ${name}` : ""}</small>
        <div className="pt-card-peak"><small>{t("最佳时段")}</small><b>{rhythmStats(state.rhythm, locale)[0]!.value}</b></div>
        {/* English details run to more lines; a shorter curve keeps the card's footer inside its 3:4 frame. */}
        <RhythmChart rhythm={state.rhythm} width={460} height={locale === "en" ? 196 : 220} />
        <RhythmStats rhythm={state.rhythm} />
        <small className="pt-card-basis">{rhythmBasis(state.rhythm, t)}</small>
        <small className="pt-card-foot">{t(RHYTHM_CREDIBILITY)} · Crossline{publicUrl ? ` · ${publicUrl}` : ""}</small>
      </div>
      <div ref={sharedHalf} className="pt-doc pt-shared-half"><SharePart report={shared} state={state} ordered={ordered} />{footer}<p className="pt-credibility">{t(CREDIBILITY)}</p></div>
    </div>
  </div>;
}
