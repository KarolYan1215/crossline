"use client";

import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import { useT } from "../locale-context";
import { buildDivergenceGraph, fitsEntries, fitsFirst, isUrl, type FitsEntry, type GraphNode } from "./divergence-graph";
import { falsifierCondition } from "./insight-card";
import { DIMENSION_IDS, DIMENSION_LABEL, type DimensionId, type Hypothesis } from "./interview-contract";
import { PointsList } from "./points-list";
import type { ProfilePoint } from "@crossline/core";

const STATUS_LABEL: Record<Hypothesis["status"], string> = { open: "待验证", supported: "已支持", refuted: "已推翻", undecided: "未定论" };
const BASIS_LABEL: Record<Hypothesis["basis"][number]["kind"], string> = { quote: "原话", behavior: "行为", external: "外部" };

/**
 * The map in the right column (decision 25): dimensions, hypotheses and evidence as a radial graph, a node opened below it. The pictures
 * the stages drew before stay, as the details of their dimensions (`detail`: D4 the values radar, D1 and D7 the energy plane, D5 the lines).
 * What the person rated 准 is listed first and drawn heavier (decision 23).
 */
export function DivergenceView({ hypotheses, dimensions, insights, ratings, initial, detail, points }: {
  hypotheses: Hypothesis[] | undefined;
  dimensions: import("./interview-contract").DimensionNote[] | undefined;
  /** The observation cards of the conversation, by round, for the 「准」 list. */
  insights: Array<{ seq: number; text: string }>;
  ratings: Record<string, "fits" | "off" | "partial"> | undefined;
  /** Under the points rules, the points ledger: listed above the map in place of the 「准」 list (a confirmed inference is one of them). */
  points?: ProfilePoint[];
  /** The dimension opened first (the one the current stage is about), if any. */
  initial?: DimensionId | undefined;
  detail: (dimension: DimensionId) => ReactNode;
}) {
  const t = useT();
  const graph = buildDivergenceGraph({ hypotheses, dimensions });
  const [selected, setSelected] = useState<string | undefined>(initial);
  // A new stage opens its own dimension; one the person opened stays until then.
  useEffect(() => { if (initial) setSelected(initial); }, [initial]);
  const fits = fitsEntries(hypotheses, insights, ratings);
  const node = graph.nodes.find((item) => item.id === selected);
  const select = (id: string) => setSelected((current) => current === id ? undefined : id);
  const label = (item: GraphNode) => item.kind === "dimension" ? `${item.id} ${t(item.label)}` : item.kind === "hypothesis" ? item.hypothesis.statement : item.basis.text;
  return <div className="ob-view ob-map">
    {points ? <PointsList points={points} /> : fits.length > 0 && <FitsList entries={fits} onOpen={(entry) => entry.hypothesisId && setSelected(entry.hypothesisId)} />}
    <svg className="ob-map-svg" viewBox={`0 0 ${graph.size} ${graph.size}`} role="group" aria-label={t("画像发散图：维度、假设与证据")}>
      <circle cx={graph.centre} cy={graph.centre} r={graph.size * 0.27} className="ob-map-ring" />
      {graph.edges.map((edge) => <line key={edge.id} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} className="ob-map-edge" data-kind={edge.kind}
        data-active={selected && (edge.from === selected || edge.to === selected) ? true : undefined} />)}
      <circle cx={graph.centre} cy={graph.centre} r={5} className="ob-map-centre" />
      {graph.nodes.map((item) => {
        const common = { role: "button", tabIndex: 0, "aria-label": label(item), "aria-pressed": selected === item.id,
          onClick: () => select(item.id), onKeyDown: (event: KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(item.id); } } };
        if (item.kind === "dimension") return <g key={item.id} {...common} className="ob-map-node" data-kind="dimension" data-evidenced={item.evidenced || undefined}>
          <circle cx={item.x} cy={item.y} r={14} /><text x={item.x} y={item.y + 4} textAnchor="middle">{item.id}</text>
          <title>{`${item.id} ${t(item.label)}`}</title></g>;
        if (item.kind === "hypothesis") return <g key={item.id} {...common} className="ob-map-node" data-kind="hypothesis" data-status={item.hypothesis.status} data-fits={item.fits || undefined}>
          <circle cx={item.x} cy={item.y} r={item.fits ? 9 : 7.5} /><text x={item.x} y={item.y + 3} textAnchor="middle">{item.number}</text>
          <title>{item.hypothesis.statement}</title></g>;
        return <g key={item.id} {...common} className="ob-map-node" data-kind="evidence" data-basis={item.basis.kind}>
          <circle cx={item.x} cy={item.y} r={3} /><title>{item.basis.text}</title></g>;
      })}
    </svg>
    <p className="ob-legend ob-map-legend"><span className="ob-map-key" data-k="supports" />{t("支持")} <span className="ob-map-key" data-k="refutes" />{t("反驳")}
      <span className="ob-map-key" data-k="pending" />{t("待定")} <span className="ob-map-key" data-k="fits" />{t("本人标为准")}</p>
    <ul className="ob-map-dimensions" aria-label={t("十个维度")}>{DIMENSION_IDS.map((id) => {
      const count = (hypotheses ?? []).filter((item) => item.dimension === id).length;
      return <li key={id}><button type="button" aria-pressed={selected === id} onClick={() => select(id)}>
        <b>{id}</b> {t(DIMENSION_LABEL[id])}{count > 0 && <small>{count}</small>}</button></li>;
    })}</ul>
    {node && <NodeDetail node={node} hypotheses={hypotheses ?? []} detail={detail} onOpen={setSelected} />}
  </div>;
}

function FitsList({ entries, onOpen }: { entries: FitsEntry[]; onOpen: (entry: FitsEntry) => void }) {
  const t = useT();
  return <section className="ob-map-fits" aria-label={t("本人标为准")}>
    <b>{t("本人标为准")}</b>
    <ul>{entries.map((entry) => <li key={entry.key}>
      {entry.hypothesisId ? <button type="button" className="gen" onClick={() => onOpen(entry)}>{entry.text}</button> : <span className="gen">{entry.text}</span>}
      {entry.dimension && <small>{entry.dimension}</small>}
    </li>)}</ul>
  </section>;
}

function Falsifier({ text }: { text: string }) {
  const t = useT();
  const condition = falsifierCondition(text);
  return condition ? <p className="ob-map-falsifier">{t("如果{{falsifier}}，这条就不准", { falsifier: condition })}</p> : null;
}

function NodeDetail({ node, hypotheses, detail, onOpen }: { node: GraphNode; hypotheses: Hypothesis[]; detail: (dimension: DimensionId) => ReactNode; onOpen: (id: string) => void }) {
  const t = useT();
  if (node.kind === "dimension") {
    const own = fitsFirst(hypotheses.filter((item) => item.dimension === node.id));
    return <section className="ob-map-detail" aria-label={t("{{id}} {{label}}", { id: node.id, label: t(node.label) })}>
      <header><b>{node.id} {t(node.label)}</b><small>{node.evidenced ? t("已有本人原话或行为证据") : t("还没有本人的证据")}</small></header>
      {node.summary && <p className="gen">{node.summary}</p>}
      {own.length > 0 && <ul className="ob-map-hypotheses">{own.map((item) => <li key={item.id} data-status={item.status} data-fits={item.rated === "fits" || undefined}>
        <button type="button" className="gen" onClick={() => onOpen(item.id)}>{item.statement}</button><small>{t(STATUS_LABEL[item.status])}</small></li>)}</ul>}
      {detail(node.id)}
    </section>;
  }
  if (node.kind === "hypothesis") {
    const item = node.hypothesis;
    return <section className="ob-map-detail" aria-label={t("假设")} data-fits={node.fits || undefined}>
      <header><b>{t("假设 {{n}}", { n: node.number })}</b><small>{item.dimension} {t(DIMENSION_LABEL[item.dimension])} · {t(STATUS_LABEL[item.status])}
        {item.rated === "fits" ? t(" · 本人标为准") : item.rated === "off" ? t(" · 本人标为不准") : item.rated === "partial" ? t(" · 本人说部分对") : ""}</small></header>
      <p className="gen ob-map-statement">{item.statement}</p>
      {item.basis.length > 0 && <ul className="ob-map-basis">{item.basis.map((basis, index) => <li key={index} data-basis={basis.kind}>
        <small>{t(BASIS_LABEL[basis.kind])}</small>
        {isUrl(basis.ref) ? <a href={basis.ref} target="_blank" rel="noreferrer noopener" className="gen">{basis.text}</a>
          : <span className="gen">{basis.kind === "quote" ? t("「{{quote}}」", { quote: basis.text }) : basis.text}</span>}
      </li>)}</ul>}
      <Falsifier text={item.falsifier} />
      {item.alternative && <p className="ob-map-alt">{t("另一种解释：")}<span className="gen">{item.alternative}</span></p>}
      {item.reference?.url && <p className="ob-map-ref">{t("参照：")}<a href={item.reference.url} target="_blank" rel="noreferrer noopener" className="gen">{item.reference.text || item.reference.url}</a></p>}
    </section>;
  }
  const owner = hypotheses.find((item) => item.id === node.hypothesisId);
  return <section className="ob-map-detail" aria-label={t("证据")}>
    <header><b>{t(BASIS_LABEL[node.basis.kind])}</b>{owner && <small>{t(owner.status === "supported" ? "支持" : owner.status === "refuted" ? "反驳" : "待定")}</small>}</header>
    {isUrl(node.basis.ref) ? <a href={node.basis.ref} target="_blank" rel="noreferrer noopener" className="gen">{node.basis.text}</a>
      : <p className="gen">{node.basis.kind === "quote" ? t("「{{quote}}」", { quote: node.basis.text }) : node.basis.text}</p>}
    {owner && <p className="ob-map-alt">{t("关于：")}<button type="button" className="gen" onClick={() => onOpen(owner.id)}>{owner.statement}</button></p>}
  </section>;
}
