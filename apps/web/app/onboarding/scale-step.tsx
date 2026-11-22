"use client";

import { useEffect, useState } from "react";
import { useLocale, useT } from "../locale-context";

/**
 * The scale before the interview's first round (docs/plans/2026-11-22-interview-and-import-redesign.md §二.2, D1): IPIP-NEO-120 and
 * TwIVI on seven pages, every point labelled, each tap saved at once so the scale can be left and taken up again where it stopped. The last
 * page has a free box that adds to the taps (it never stands in for them) and the results of tests taken elsewhere — a 16-type test, say —
 * recorded as the person states them; the system makes no type label of its own (D12). 「先开始访谈」 puts the scale off: it waits in the
 * right column. After 「做完了」 the scores are shown with what they are compared against, and the analysis the worker writes follows.
 */
type Item = { id: string; instrument: string; text: string; en: string; points: number; labels: string[] };
type Score = { dimension: string; label: string; score: number | null; percentile?: number; rank?: number; centered?: number };
type ScaleState = {
  pages: Item[][];
  answers: Record<string, { score?: number; skipped?: true }>;
  session: { page: number; supplement: string; selfReports: Array<{ test: string; result: string }>; completedAt?: string };
  status: { state: "todo" | "in_progress" | "done"; answered: number; total: number };
  report: { domains: Score[]; values: Score[] } | null;
  analysis: { text: string; hypotheses: Array<{ id: string; statement: string; check: string }> } | null;
  norms: string;
};

const post = (body: unknown) => fetch("/api/onboarding/scale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (response) => ({ ok: response.ok, state: await response.json().catch(() => null) as (ScaleState & { ok: boolean }) | null })).catch(() => ({ ok: false, state: null }));

export function ScaleStep({ onDone }: { onDone: () => void }) {
  const t = useT();
  const locale = useLocale();
  const [state, setState] = useState<ScaleState | null>(null);
  const [page, setPage] = useState(0);
  const [supplement, setSupplement] = useState("");
  const [reports, setReports] = useState<Array<{ test: string; result: string }>>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/onboarding/scale").then((response) => response.json() as Promise<ScaleState>).then((next) => {
      setState(next); setPage(next.session.page); setSupplement(next.session.supplement);
      setReports(next.session.selfReports.length ? next.session.selfReports : [{ test: "", result: "" }]);
    }).catch(() => setError(t("量表没有载入，请刷新重试。")));
  }, [t]);

  if (!state) return <section className="ob-scale" aria-busy="true"><h2>{t("首先，让我们完成一份量表")}</h2>{error && <p className="ob-error" role="alert">{error}</p>}</section>;

  const items = state.pages[page] ?? [];
  const last = page === state.pages.length - 1;
  const done = state.status.state === "done";
  const apply = (result: { ok: boolean; state: (ScaleState & { ok: boolean }) | null }) => {
    if (!result.ok || !result.state) { setError(t("没有保存成功，请重试。")); return false; }
    setError(""); setState(result.state); return true;
  };
  const answer = async (itemId: string, score: number | null) => {
    // Shown at once; the ledger is written behind it.
    setState((previous) => previous && { ...previous, answers: { ...previous.answers, [itemId]: score === null ? { skipped: true } : { score } } });
    apply(await post({ action: "answers", answers: [{ itemId, score }] }));
  };
  const turn = async (next: number) => { setPage(next); window.scrollTo?.({ top: 0 }); await post({ action: "page", page: next }); };
  const finish = async () => {
    setSaving(true);
    const kept = reports.filter((report) => report.test.trim() && report.result.trim());
    const ok = apply(await post({ action: "supplement", text: supplement })) && apply(await post({ action: "self_reports", reports: kept }))
      && apply(await post({ action: "complete" }));
    setSaving(false);
    if (!ok) return;
  };
  const defer = async () => { setSaving(true); const result = await post({ action: "defer" }); setSaving(false); if (apply(result)) onDone(); };

  if (done) return <section className="ob-scale" aria-label={t("量表结果")}>
    <h2>{t("量表做完了")}</h2>
    {state.report && <>
      <ul className="ob-scale-scores">
        {state.report.domains.filter((score) => score.percentile !== undefined).map((score) =>
          <li key={score.dimension}>{t("{{label}}：第 {{n}} 百分位", { label: t(score.label), n: score.percentile })}</li>)}
      </ul>
      {state.report.values.some((score) => score.rank) && <p>{t("价值观（你自己的排序，高到低）：{{values}}", {
        values: state.report.values.filter((score) => score.rank).map((score) => t(score.label)).join(t("、")) })}</p>}
      <p className="ob-muted" lang="zh">{state.norms}</p>
    </>}
    {state.analysis ? <div className="ob-scale-analysis gen">{state.analysis.text.split(/\n+/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</div>
      : <p className="ob-muted">{t("分析在后台写，写好后会出现在右栏的画像里；访谈会参照它。")}</p>}
    <button type="button" className="ob-btn" onClick={onDone}>{t("开始访谈")}</button>
  </section>;

  return <section className="ob-scale" aria-label={t("量表")}>
    <h2>{t("首先，让我们完成一份量表")}</h2>
    <p className="ob-muted">{t("共 {{total}} 题，分 {{pages}} 页。每题按第一感觉点选；可以跳过，可以随时离开，回来从停下的地方接着做。", { total: state.status.total, pages: state.pages.length })}</p>
    <p className="ob-muted">{t("第 {{page}} / {{pages}} 页 · 已答 {{answered}} 题", { page: page + 1, pages: state.pages.length, answered: Object.keys(state.answers).length })}</p>
    {page === state.pages.length - 1 && <p>{t("下面每段描述一个人。这个人有多像你？")}</p>}
    <ol className="ob-scale-items">
      {items.map((item) => {
        const current = state.answers[item.id];
        return <li key={item.id} className="ob-scale-item">
          <p className="ob-scale-text">{locale === "en" ? item.en : item.text}</p>
          <div className="ob-scale-points" role="radiogroup" aria-label={locale === "en" ? item.en : item.text}>
            {item.labels.map((label, index) => <button key={index} type="button" role="radio" aria-checked={current?.score === index + 1}
              className={current?.score === index + 1 ? "ob-chip on" : "ob-chip"} onClick={() => void answer(item.id, index + 1)}>{label}</button>)}
            <button type="button" className={current?.skipped ? "ob-chip on ob-quiet" : "ob-chip ob-quiet"} aria-pressed={Boolean(current?.skipped)}
              onClick={() => void answer(item.id, null)}>{t("跳过")}</button>
          </div>
        </li>;
      })}
    </ol>
    {last && <div className="ob-scale-more">
      <label>{t("还想补充的（可选）：这些题没问到、或者点选说不清的")}
        <textarea value={supplement} maxLength={4000} rows={4} onChange={(event) => setSupplement(event.target.value)} />
      </label>
      <p className="ob-muted">{t("补充只是补充，不会替代你的点选。")}</p>
      <fieldset>
        <legend>{t("以前做过其他测试（比如 16 型人格）？可以把结果写在这里，按你自己的说法记下。")}</legend>
        {reports.map((report, index) => <div key={index} className="ob-scale-report">
          <input aria-label={t("测试名")} placeholder={t("测试名")} value={report.test} maxLength={80}
            onChange={(event) => setReports((previous) => previous.map((entry, at) => at === index ? { ...entry, test: event.target.value } : entry))} />
          <input aria-label={t("结果")} placeholder={t("结果")} value={report.result} maxLength={200}
            onChange={(event) => setReports((previous) => previous.map((entry, at) => at === index ? { ...entry, result: event.target.value } : entry))} />
        </div>)}
        {reports.length < 8 && <button type="button" className="ob-btn ob-quiet" onClick={() => setReports((previous) => [...previous, { test: "", result: "" }])}>{t("再加一个")}</button>}
      </fieldset>
    </div>}
    {error && <p className="ob-error" role="alert">{error}</p>}
    <div className="ob-scale-nav">
      {page > 0 && <button type="button" className="ob-btn ob-quiet" onClick={() => void turn(page - 1)}>{t("上一页")}</button>}
      {!last && <button type="button" className="ob-btn" onClick={() => void turn(page + 1)}>{t("下一页")}</button>}
      {last && <button type="button" className="ob-btn" disabled={saving} onClick={() => void finish()}>{t("做完了")}</button>}
      <button type="button" className="ob-btn ob-quiet" disabled={saving} onClick={() => void defer()}>{t("先开始访谈，量表之后再做")}</button>
    </div>
  </section>;
}

/** Whether the scale page comes before the first round: not done and not put off. A failed read lets the interview start. */
export async function scaleNeeded(): Promise<boolean> {
  try {
    const state = await fetch("/api/onboarding/scale").then((response) => response.json() as Promise<{ session?: { completedAt?: string; deferredAt?: string } }>);
    return Boolean(state.session && !state.session.completedAt && !state.session.deferredAt);
  } catch { return false; }
}
