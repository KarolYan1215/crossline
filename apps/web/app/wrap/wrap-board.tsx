"use client";

import { useState } from "react";
import type { WrapOutcome, WrapView } from "../../lib/wrap";
import { AnswerAll } from "../asks/answer-all";
import { useT } from "../locale-context";
import { PENDING_CHANGED } from "../pending-badge";

const OUTCOMES: Array<{ id: WrapOutcome; label: string }> = [{ id: "done", label: "完成" }, { id: "partial", label: "部分" }, { id: "not_done", label: "没做" }];
const ANSWERED: Record<string, string> = { not_done: "没做，已顺延", partial: "做了一部分", as_planned: "完成", over: "完成", under: "完成" };

/**
 * The evening wrap-up's page (docs/rituals.md): each of today's blocks with 完成 / 部分 / 没做, one tap each, what was not done rolling
 * forward; below, 「全部按推荐」 for the day's decisions with a safe default; then 「收工」.
 */
export function WrapBoard({ view }: { view: WrapView }) {
  const t = useT();
  const [answers, setAnswers] = useState<Record<string, string>>(() => Object.fromEntries(view.rows.flatMap((row) => row.answered ? [[row.blockId, row.answered]] : [])));
  const [busy, setBusy] = useState<string | undefined>();
  const [finished, setFinished] = useState(view.done);
  const [failed, setFailed] = useState(false);
  const answer = async (blockId: string, outcome: WrapOutcome) => {
    setBusy(blockId);
    setFailed(false);
    const response = await fetch("/api/wrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ blockId, outcome }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; done?: string } | undefined;
    setBusy(undefined);
    if (!body?.ok) { setFailed(true); return; }
    setAnswers({ ...answers, [blockId]: outcome === "done" ? "as_planned" : outcome });
    window.dispatchEvent(new Event(PENDING_CHANGED));
  };
  const finish = async () => {
    setBusy("finish");
    const response = await fetch("/api/wrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ finish: true }) }).catch(() => undefined);
    setBusy(undefined);
    if (response?.ok) setFinished(true); else setFailed(true);
  };
  const open = view.rows.filter((row) => !answers[row.blockId]).length;
  return <section className="ritual-card">
    <p className="ritual-lead">{view.rows.length ? t("今天排过 {{count}} 块工作，逐个点一下；没做的会顺延到后面的空档。", { count: view.rows.length })
      : t("今天没有排过的工作块。")}</p>
    {view.rows.length > 0 && <ul className="ritual-rows">{view.rows.map((row) => {
      const answered = answers[row.blockId];
      return <li key={row.blockId}>
        <div className="ritual-row-main">
          <a href={`/workbench/${encodeURIComponent(row.orderId)}`} title={row.title}>{row.step ? `${row.title} · ${row.step}` : row.title}</a>
          <small className="muted mono">{row.start}–{row.end}</small>
        </div>
        {answered ? <span className="ritual-answered">{t(ANSWERED[answered] ?? "完成")}</span>
          : <div className="ritual-choices" role="group" aria-label={t("{{title}} 做得怎么样", { title: row.title })}>
            {OUTCOMES.map((item) => <button key={item.id} type="button" className="secondary-button" disabled={Boolean(busy)}
              onClick={() => void answer(row.blockId, item.id)}>{t(item.label)}</button>)}
          </div>}
      </li>;
    })}</ul>}
    {failed && <p role="alert">{t("没有成功，请稍后再试。")}</p>}
    <h2 className="section-label">{t("可按推荐处理的待决事项")}</h2>
    <AnswerAll />
    <p className="muted">{t("需要本人回答的问题留在待确认，明早简报会再列一次。")} <a href="/approvals#asks">{t("去待确认")}</a></p>
    <div className="ritual-actions">
      {finished ? <p role="status">{t("已收工。今晚不再提醒，明早简报见。")}</p>
        : <button type="button" className="primary-button" disabled={Boolean(busy)} onClick={() => void finish()}>
          {open ? t("收工（{{count}} 块未确认）", { count: open }) : t("收工")}</button>}
    </div>
  </section>;
}
