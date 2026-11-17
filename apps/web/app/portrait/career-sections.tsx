"use client";

import { useT } from "../locale-context";
import { falsifierCondition } from "../onboarding/insight-card";
import { fitsFirst, isUrl } from "../onboarding/divergence-graph";
import { DIMENSION_IDS, DIMENSION_LABEL, type CareerOption, type Hypothesis } from "../onboarding/interview-contract";

const HAS_LABEL: Record<CareerOption["requirements"][number]["has"], string> = { yes: "满足", partial: "部分", no: "缺口" };
const STATUS_LABEL: Record<Hypothesis["status"], string> = { open: "待验证", supported: "已支持", refuted: "已推翻", undecided: "未定论" };

const External = ({ url, children }: { url: string; children: string }) => <a href={url} target="_blank" rel="noreferrer noopener" className="gen">{children}</a>;

/**
 * 「职业方向」 (decision 16, contract B): each role with why the portrait points to it, what its public postings ask for against the
 * person's own evidence (reference group B), the postings it rests on, and a two-to-four-week trial that would support or refute it.
 */
export function CareerSection({ careers, lineLabel, number }: { careers: CareerOption[]; lineLabel: (id: string) => string; number: string }) {
  const t = useT();
  if (!careers.length) return null;
  return <section className="pt-page" data-private="" id="pt-s-careers">
    <h2><small>{number}</small>{t("职业方向")}</h2>
    {careers.map((career, index) => <article key={`${career.role}:${index}`} className="pt-career">
      <header><h3 className="gen">{career.role}</h3>{career.lineId && <small>{t("主线：{{line}}", { line: lineLabel(career.lineId) })}</small>}</header>
      <p className="gen pt-lead">{career.why}</p>
      {career.requirements.length > 0 && <div className="pt-table-wrap"><table className="pt-requirements">
        <caption>{t("岗位要求与本人证据（来自公开招聘信息）")}</caption>
        <thead><tr><th scope="col">{t("要求")}</th><th scope="col">{t("出现比例")}</th><th scope="col">{t("本人")}</th><th scope="col">{t("证据")}</th></tr></thead>
        <tbody>{career.requirements.map((row, rowIndex) => <tr key={`${row.requirement}:${rowIndex}`} data-has={row.has}>
          <th scope="row" className="gen">{row.requirement}</th><td>{row.share}</td><td><span className="pt-has" data-has={row.has}>{t(HAS_LABEL[row.has])}</span></td>
          <td className="gen">{row.evidence}</td></tr>)}</tbody>
      </table></div>}
      {career.sources.length > 0 && <ul className="pt-sources" aria-label={t("来源")}>{career.sources.map((url) =>
        <li key={url}>{isUrl(url) ? <External url={url}>{url}</External> : <span className="gen">{url}</span>}</li>)}</ul>}
      <div className="pt-trial">
        <small>{t("试做 · {{weeks}} 周", { weeks: career.trial.weeks })}</small>
        <p className="gen">{career.trial.task}</p>
        <dl>
          <div><dt>{t("支持这个方向，如果")}</dt><dd className="gen">{career.trial.supportsIf}</dd></div>
          <div><dt>{t("推翻这个方向，如果")}</dt><dd className="gen">{career.trial.refutesIf}</dd></div>
        </dl>
      </div>
    </article>)}
  </section>;
}

/**
 * 「假设」 (decisions 3, 9 and 23): the interview's hypotheses by dimension, each with its verdict, what it rests on, what would refute it,
 * the other reading, and a reference with its source; the ones the person rated 准 first in their dimension.
 */
export function HypothesesSection({ hypotheses, number }: { hypotheses: Hypothesis[]; number: string }) {
  const t = useT();
  if (!hypotheses.length) return null;
  const groups = DIMENSION_IDS.map((id) => ({ id, items: fitsFirst(hypotheses.filter((item) => item.dimension === id)) })).filter((group) => group.items.length);
  return <section className="pt-page" data-private="" id="pt-s-hypotheses">
    <h2><small>{number}</small>{t("假设")}</h2>
    <p className="pt-credibility">{t("访谈中提出并检验过的推断；标「本人认为准」的由本人确认")}</p>
    {groups.map((group) => <div key={group.id} className="pt-hypothesis-group">
      <h3>{group.id} {t(DIMENSION_LABEL[group.id])}</h3>
      <ol className="pt-hypotheses">{group.items.map((item) => { const condition = falsifierCondition(item.falsifier);
        return <li key={item.id} data-status={item.status} data-fits={item.rated === "fits" || undefined}>
          <header><span className="tag">{t(STATUS_LABEL[item.status])}</span>{item.rated === "fits" && <b className="pt-fits">{t("本人认为准")}</b>}</header>
          <p className="gen">{item.statement}</p>
          {item.basis.length > 0 && <ul className="pt-basis">{item.basis.map((basis, index) => <li key={index}>
            {isUrl(basis.ref) ? <External url={basis.ref}>{basis.text}</External>
              : <span className="gen">{basis.kind === "quote" ? t("「{{quote}}」", { quote: basis.text }) : basis.text}</span>}</li>)}</ul>}
          {condition && <small>{t("如果{{falsifier}}，这条就不准", { falsifier: condition })}</small>}
          {item.alternative && <small>{t("另一种解释：")}<span className="gen">{item.alternative}</span></small>}
          {item.reference?.url && <small>{t("参照：")}<External url={item.reference.url}>{item.reference.text || item.reference.url}</External></small>}
        </li>; })}</ol>
    </div>)}
  </section>;
}
