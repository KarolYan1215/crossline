"use client";

import "./materials.css";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Markdown } from "../ui/markdown";
import { cleanText, firstSentence } from "./humanize";
import { KIND_LABEL, buildTutorial, stepAnchor, tutorialAnchor, type Book } from "./tutorial-model";
import { useT } from "../locale-context";
import { withLink } from "../onboarding/rich-text";

export type TutorialViewProps = {
  workOrderId: string;
  /** The order is in `preparing`: the book is being built for it, so the view polls. */
  building?: boolean;
  /** False for a task whose steps are its preparation (`preparation.level` other than `tutorial`); the button still makes one. */
  auto?: boolean;
  /** Why the task gets no tutorial by itself (`preparation.reason`), said in place of the general line. */
  reason?: string;
  /** Offer 生成教程 / 重新生成 (off where the person cannot change the task). */
  canBuild?: boolean;
  /** Where a section's 「回到步骤」 goes. Default `#step-<stepId>`: the task's step rows carry `id={stepAnchor(step.id)}`. */
  stepHref?: (stepId: string) => string;
  /**
   * `page`: the reading page, with a table of contents beside the text on a wide screen. `inline` (default): every section in full.
   * `toc`: the task detail's view — one line per step (number, title, what it is for, how many materials), each opening its section in
   * place; only `currentStepId`'s section starts open. The whole book stays on the reading page (`/materials/<id>`).
   */
  layout?: "inline" | "page" | "toc";
  /** With `toc`: the step whose section starts open (the task's current step). */
  currentStepId?: string;
};

type Status = { building: boolean; closed?: boolean; progress: { stage: string; done: number; total: number } | null; blocker: string | null };
type Loaded = (Status & { built: false }) | (Status & Book & { built: true });

const STAGE: Record<string, string> = { designing: "设计步骤", researching: "查找资料", writing: "撰写教程与解析", assembling: "整理" };
const KEPT: Record<string, string> = { full_text: "已存全文", summary_only: "链接与摘要", unverified: "未能自动核实" };

/** 「见第 1、3 步」 / "See steps 1, 3": the translated sentence with the step links put where its `<a>` part is. */
const seeSteps = (sentence: string, links: ReactNode[]) => withLink(sentence, () => <>{links}</>);

/**
 * The task's tutorial as one reading page: a numbered section per step of the task (each linked to its step and back), a box with what
 * the step is for, how it counts as done and what is still missing, the guide itself, the materials for that step, the analysis of the
 * material one fold away, and every source once, as a numbered footnote. A bar shows how far through the steps the reader is.
 * 生成教程 asks for one when there is none; while one is being built its progress shows, and a stopped build says why.
 */
export function TutorialView({ workOrderId, building: preparing = false, auto = true, reason, canBuild = true, stepHref = (id) => `#${stepAnchor(id)}`, layout = "inline", currentStepId }: TutorialViewProps) {
  const t = useT();
  const [state, setState] = useState<Loaded | undefined>();
  const [asked, setAsked] = useState(false);
  const [current, setCurrent] = useState(0);
  const sectionsRef = useRef<HTMLOListElement>(null);
  // With `toc`: which sections are open. The current step's starts open; a link to `#tutorial-<step>` (a step row's 「本步的教程与材料」)
  // opens that one.
  const [open, setOpen] = useState<Set<string>>(() => new Set(currentStepId ? [tutorialAnchor(currentStepId)] : []));
  useEffect(() => {
    if (layout !== "toc") return;
    const follow = () => {
      const target = decodeURIComponent(location.hash.slice(1));
      if (target.startsWith("tutorial-")) setOpen((set) => set.has(target) ? set : new Set([...set, target]));
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, [layout]);

  const look = async () => {
    const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/manualbook`, { cache: "no-store" }).catch(() => undefined);
    const next = await response?.json().catch(() => undefined) as Loaded | undefined;
    if (next) setState(next);
  };
  useEffect(() => { void look(); }, [workOrderId]); // eslint-disable-line react-hooks/exhaustive-deps
  const running = Boolean(state?.building || preparing || asked);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void look(), 5000);
    return () => clearInterval(timer);
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (state && !state.building && asked && (state.built || state.blocker)) setAsked(false); }, [state, asked]);

  const tutorial = useMemo(() => state?.built ? buildTutorial(workOrderId, state) : undefined, [state, workOrderId]);

  // Reading progress: the section whose heading last passed the top of the screen.
  useEffect(() => {
    const list = sectionsRef.current;
    if (!list || typeof IntersectionObserver === "undefined") return;
    const items = [...list.querySelectorAll<HTMLElement>(":scope > li")];
    const observer = new IntersectionObserver(() => {
      const passed = items.filter((item) => item.getBoundingClientRect().top < 160).length;
      setCurrent(Math.max(0, passed - 1));
    }, { rootMargin: "-120px 0px -40% 0px", threshold: [0, 1] });
    for (const item of items) observer.observe(item);
    return () => observer.disconnect();
  }, [tutorial]);

  const generate = async () => {
    setAsked(true);
    const response = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/tutorial`, { method: "POST" }).catch(() => null);
    if (!response?.ok) setAsked(false);
    void look();
  };
  if (!state) return <p className="muted" role="status">{t("读取中…")}</p>;
  const status = running
    ? <p role="status" className="muted">{state.progress
      ? t("正在生成教程：{{stage}}（{{done}}/{{total}}）…", { stage: STAGE[state.progress.stage] ? t(STAGE[state.progress.stage]!) : state.progress.stage, done: state.progress.done, total: state.progress.total })
      : t("正在生成教程：排队中…")}</p>
    : state.blocker ? <p role="status">{t("上次未能生成：{{reason}}", { reason: state.blocker })}</p> : null;

  // A finished task without a tutorial gets none now: saying one 「会自动生成」 was wrong after 完成 (W-16).
  if ((!state.built || !tutorial) && state.closed) return <section className="tutorial-view" aria-label={t("教程")}>
    <p className="muted">{t("任务已完成，没有生成教程。")}</p>
  </section>;
  if (!state.built || !tutorial) return <section className="tutorial-view" aria-label={t("教程")}>
    {status}
    {!running && <p className="muted">{auto
      ? t("教程按该任务的步骤逐步写出：先读本人上传的课程文件，需要外部资料的步骤再联网查找，每份材料附针对本任务的解析。开工前 3 天自动生成。")
      : reason ? t("{{reason}}需要时可以点下方按钮生成。", { reason }) : t("这项任务较短，系统不自动生成教程。需要时可以点下方按钮生成。")}</p>}
    {!running && canBuild && <button type="button" className="primary-button" onClick={() => void generate()}>{state.blocker ? t("重新生成") : t("生成教程")}</button>}
  </section>;

  const fn = (n: number) => `tv-fn-${workOrderId}-${n}`;
  // In the table of contents the footnotes are on the reading page, so a mark links there.
  const footnoteHref = (n: number) => layout === "toc" ? `/materials/${encodeURIComponent(workOrderId)}#${fn(n)}` : `#${fn(n)}`;
  const cite = (n: number, key: string) => <sup key={key} className="tv-cite"><a href={footnoteHref(n)} aria-label={t("来源 {{n}}", { n })}>{n}</a></sup>;
  const total = tutorial.sections.length;
  const materialHref = (index: number) => {
    const material = state.materials.find((item) => item.index === index);
    return material?.docId ? `/workbench/${encodeURIComponent(workOrderId)}/material?doc=${encodeURIComponent(material.docId)}` : `/workbench/${encodeURIComponent(workOrderId)}/material?m=${index}`;
  };
  const anchorOf = (section: (typeof tutorial.sections)[number]) => tutorialAnchor(section.stepId ?? section.nodeId);

  /** A section's body: what it is for and how it counts as done, what is missing, the guide, its materials, the analysis folded. */
  const body = (section: (typeof tutorial.sections)[number]) => <>
    {(section.goal || section.acceptance) && <dl className="tv-key">
      {section.goal && <div><dt>{t("目的")}</dt><dd className="gen">{section.goal}</dd></div>}
      {section.acceptance && <div><dt>{t("完成标准")}</dt><dd className="gen">{section.acceptance}</dd></div>}
    </dl>}
    {section.missing.length > 0 && <div className="tv-missing" role="note"><b>{t("需要补充")}</b><ul className="gen">{section.missing.map((item) => <li key={item}>{item}</li>)}</ul></div>}
    {section.guide ? <Markdown className="gen long-form tv-guide" text={section.guide} cite={cite} /> : <p className="muted">{t("该步骤没有写成教程。")}</p>}
    {section.materials.length > 0 && <p className="tv-materials"><small>{t("本步材料")}</small>{section.materials.map((index) => {
      const material = state.materials.find((item) => item.index === index);
      return material ? <a key={index} href={materialHref(index)}>{cleanText(material.title)}</a> : null;
    })}</p>}
    {section.analysis && <details className="advanced tv-analysis"><summary>{t("资料解析")}</summary><Markdown className="gen long-form" text={section.analysis} cite={cite} /></details>}
  </>;

  if (layout === "toc") return <section className="tutorial-view" data-layout="toc" aria-label={t("教程目录")}>
    {status && <div className="tv-toc-status">{status}</div>}
    <ol className="tv-toc-list">{tutorial.sections.map((section) => {
      const anchor = anchorOf(section);
      const expanded = open.has(anchor);
      const toggle = () => setOpen((set) => { const next = new Set(set); if (next.has(anchor)) next.delete(anchor); else next.add(anchor); return next; });
      return <li key={section.nodeId} id={anchor} className="tv-toc-item" data-open={expanded || undefined}>
        <button type="button" className="tv-toc-head" aria-expanded={expanded} aria-controls={`${anchor}-body`} onClick={toggle}>
          <span className="tv-num tv-num-big mono" aria-hidden="true">{section.number}</span>
          <span className="tv-toc-title">{section.title}</span>
          <span className="tv-toc-facts">
            {currentStepId && section.stepId === currentStepId && <span className="tag">{t("当前")}</span>}
            {section.materials.length > 0 && <small className="mono">{t("{{count}} 份材料", { count: section.materials.length })}</small>}
          </span>
          {section.goal && <span className="tv-toc-goal gen">{firstSentence(section.goal)}</span>}
        </button>
        {expanded && <div className="tv-toc-body" id={`${anchor}-body`}>
          <p className="tv-toc-links">{section.stepId && <a href={stepHref(section.stepId)}>{t("回到步骤")}</a>}
            <a href={`/materials/${encodeURIComponent(workOrderId)}#${anchor}`}>{t("在阅读页打开")}</a></p>
          {body(section)}
        </div>}
      </li>;
    })}</ol>
  </section>;

  return <section className="tutorial-view" data-layout={layout} aria-label={t("教程")}>
    <header className="tv-head">
      <div className="tv-progress" role="progressbar" aria-label={t("阅读进度")} aria-valuemin={1} aria-valuemax={total} aria-valuenow={current + 1}
        aria-valuetext={t("第 {{n}} 步，共 {{total}} 步", { n: current + 1, total })}>
        <span className="tv-progress-fill" style={{ width: `${total ? ((current + 1) / total) * 100 : 0}%` }} />
      </div>
      <p className="tv-head-line"><span className="mono">{t("第 {{n}} / {{total}} 步", { n: current + 1, total })}</span>
        <span className="tv-head-title">{tutorial.sections[current]?.title}</span>
        {status ?? (canBuild && !running && <button type="button" className="text-button" onClick={() => void generate()}>{t("重新生成")}</button>)}</p>
    </header>

    <div className="tv-columns">
      <nav className="tv-toc" aria-label={t("教程目录")}><ol>{tutorial.sections.map((section, index) => <li key={section.nodeId} aria-current={index === current ? "step" : undefined}>
        <a href={`#${anchorOf(section)}`}><span className="tv-num mono">{section.number}</span>{section.title}</a></li>)}</ol></nav>

      <div className="tv-text">
        {tutorial.overview && <Markdown className="gen long-form tv-overview" text={tutorial.overview} cite={cite} />}
        {tutorial.assumptions.length > 0 && <details className="advanced tv-assumptions"><summary>{t("所依据的假设（{{count}}）", { count: tutorial.assumptions.length })}</summary>
          <ul className="gen">{tutorial.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}

        <ol className="tv-sections" ref={sectionsRef}>{tutorial.sections.map((section) => <li key={section.nodeId} id={anchorOf(section)} className="tv-section">
          <header className="tv-section-head">
            <span className="tv-num tv-num-big mono" aria-hidden="true">{section.number}</span>
            <h3>{section.title}</h3>
            <span className="tag">{KIND_LABEL[section.kind] ? t(KIND_LABEL[section.kind]!, { context: "step" }) : section.kind}</span>
            {section.stepId && <a className="tv-back" href={stepHref(section.stepId)}>{t("回到步骤")}</a>}
          </header>
          {body(section)}
        </li>)}</ol>

        {/* The book's reference list is part of what is read, so it is reading content (long-form) like the sections above it. */}
        {tutorial.footnotes.length > 0 && <section className="tv-footnotes long-form" aria-label={t("来源")}>
          <h3>{t("来源")}</h3>
          <ol>{tutorial.footnotes.map((note) => <li key={note.n} id={fn(note.n)}>
            {note.href ? <a href={note.href} target="_blank" rel="noreferrer noopener">{cleanText(note.title)}</a> : <span>{cleanText(note.title)}</span>}
            <small className="muted">{note.publisher || t("网络")}{KEPT[note.kept] ? ` · ${t(KEPT[note.kept]!)}` : ""}</small>
            {note.usedIn.length > 0 && <small>{seeSteps(t("见第 <a></a> 步"), note.usedIn.map((number) => {
              const section = tutorial.sections[number - 1];
              return section ? <a key={number} href={`#${anchorOf(section)}`}>{number}</a> : null;
            }).reduce<ReactNode[]>((all, link, index) => index ? [...all, t("、"), link] : [link], []))}</small>}
            {note.material !== undefined && <a href={materialHref(note.material)}>{t("解析")}</a>}
          </li>)}</ol>
        </section>}
      </div>
    </div>
  </section>;
}
