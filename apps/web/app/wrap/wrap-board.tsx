"use client";

import { useState } from "react";
import { bulkDoneRows } from "@crossline/core";
import { Check, CheckCheck, Hourglass, Moon, SkipForward, Sparkles } from "lucide-react";
import type { WrapOutcome, WrapRow, WrapView } from "../../lib/wrap";
import { dayLabel } from "../../lib/opener";
import { AnswerAll } from "../asks/answer-all";
import { formatMinutes } from "../ui/controls";
import { LineTag } from "../ui/tag";
import { ICON } from "../ui/icon-button";
import { useLocale, useT } from "../locale-context";
import { PENDING_CHANGED } from "../pending-badge";
import { Figure, RitualHead } from "../ritual-head";

/** One of tomorrow's first blocks, for the wrap-up's landing. */
export type NextDayBlock = { start: string; title: string; step?: string; line?: string };

const OUTCOMES: Array<{ id: WrapOutcome; label: string; icon: typeof Check }> = [
  { id: "done", label: "完成", icon: Check }, { id: "partial", label: "部分", icon: Hourglass }, { id: "not_done", label: "没做", icon: SkipForward }];
/** A stored answer read back as the three choices (the completion check's 「超出 / 少于预估」 are 完成). */
const choiceOf = (answered: string | undefined): WrapOutcome | undefined =>
  !answered ? undefined : answered === "not_done" ? "not_done" : answered === "partial" ? "partial" : "done";
const ANSWERED: Record<WrapOutcome, string> = { done: "已记为完成", partial: "已记为做了一部分", not_done: "没做，已顺延" };

/**
 * The evening wrap-up's page (docs/rituals.md; the 2026-10-28 redesign after `docs/plans/page-drafts-1028/wrap.html`): four figures for
 * the day (timed, blocks done, blocks still to record, tomorrow's first block); each block that started with 完成 / 部分 / 没做 as one
 * three-part control, and 「计时过的块全部按预估完成」 for the timed ones not yet recorded; 「全部按推荐」 for the day's decisions with a safe default; tomorrow's
 * first three blocks; then 「收工」. An earlier day (`?day=`) shows the same rows with no 收工 and no tomorrow.
 */
export function WrapBoard({ view, labels, tomorrow }: { view: WrapView; labels: Record<string, string>; tomorrow: NextDayBlock[] }) {
  const t = useT(), locale = useLocale();
  const [answers, setAnswers] = useState<Record<string, WrapOutcome>>(() => Object.fromEntries(view.rows.flatMap((row) => {
    const choice = choiceOf(row.answered);
    return choice ? [[row.blockId, choice]] : [];
  })));
  const [busy, setBusy] = useState<string | undefined>();
  const [finished, setFinished] = useState(view.done);
  const [failed, setFailed] = useState(false);
  const post = async (blockId: string, outcome: WrapOutcome): Promise<boolean> => {
    const response = await fetch("/api/wrap", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ blockId, outcome, ...(view.today ? {} : { day: view.day }) }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean } | undefined;
    return Boolean(body?.ok);
  };
  const answer = async (blockId: string, outcome: WrapOutcome) => {
    setBusy(blockId);
    setFailed(false);
    const ok = await post(blockId, outcome);
    setBusy(undefined);
    if (!ok) { setFailed(true); return; }
    setAnswers((current) => ({ ...current, [blockId]: outcome }));
    window.dispatchEvent(new Event(PENDING_CHANGED));
  };
  // 「计时过的块全部按预估完成」: each block not yet recorded whose timer ran inside it, one after another, through the same call as its own
  // 完成. A block nobody timed is left to its own three-part control: one tap at the end of a tiring day used to record every block whose
  // time had passed as done, timed or not, and the work it never got was dropped from the plan (the month simulation's overloaded person
  // did this 18 times in a month; docs/reports/2026-10-30-overnight/month-sim.md).
  const bulk = bulkDoneRows(view.rows, answers);
  const allDone = async () => {
    setBusy("all");
    setFailed(false);
    const recorded: Record<string, WrapOutcome> = {};
    for (const row of bulk) {
      if (await post(row.blockId, "done")) recorded[row.blockId] = "done"; else setFailed(true);
    }
    setAnswers((current) => ({ ...current, ...recorded }));
    setBusy(undefined);
    window.dispatchEvent(new Event(PENDING_CHANGED));
  };
  const finish = async () => {
    setBusy("finish");
    const response = await fetch("/api/wrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ finish: true }) }).catch(() => undefined);
    setBusy(undefined);
    if (response?.ok) setFinished(true); else setFailed(true);
  };

  const open = view.rows.filter((row) => !answers[row.blockId]).length;
  const doneCount = view.rows.filter((row) => answers[row.blockId] === "done").length;
  const timed = (minutes: number) => minutes ? t("计时 {{time}}", { time: formatMinutes(minutes, locale) }) : t("未计时");
  const hours = Math.floor(view.timedMinutes / 60), rest = view.timedMinutes % 60;
  const first = tomorrow[0];
  const sub = view.today
    ? (view.at ? t("{{day}} · 最后一个可用时段 {{at}} 结束", { day: dayLabel(view.day, locale), at: view.at }) : dayLabel(view.day, locale))
    : t("{{day}} · 补记那天开始过的块，写法与当天相同", { day: dayLabel(view.day, locale) });

  return <>
    <RitualHead title={view.today ? t("收工") : t("补记 {{day}}", { day: dayLabel(view.day, locale) })} sub={sub} actions={view.today
      ? (finished ? <p role="status" className="rd-status"><Moon {...ICON} />{t("已收工。今晚不再提醒，明早简报见。")}</p>
        : <button type="button" className="primary-button rd-icon-text" disabled={Boolean(busy)} onClick={() => void finish()}>
          <Moon {...ICON} />{open ? t("收工（{{count}} 块未确认）", { count: open }) : t("收工")}</button>)
      : <a className="secondary-button" href="/">{t("回到今日")}</a>} />

    <ul className="rd-kpis" aria-label={t("这一天的数")}>
      <li className="rd-card"><span className="rd-label">{view.today ? t("今天计时") : t("当天计时")}</span>
        <Figure value={hours ? <>{hours}<small>h</small> {rest}</> : rest} unit={t("分")} /></li>
      <li className="rd-card"><span className="rd-label">{t("记为完成的块")}</span><b className="rd-figure"><span className="ds-serif">{doneCount}</span><small>/ {view.rows.length}</small></b></li>
      <li className="rd-card"><span className="rd-label">{t("待确认的块")}</span><Figure value={open} {...(open ? { tone: "alarm" as const } : {})} /></li>
      {view.today && <li className="rd-card"><span className="rd-label">{t("明天第一块")}</span>
        <b className="rd-figure rd-figure-text">{first ? <><span className="ds-serif">{first.start}</span> {first.title}</> : <span>{t("还没有排")}</span>}</b></li>}
    </ul>

    <div className="wr-grid">
      <section className="rd-card wr-blocks" aria-labelledby="wr-blocks-title">
        <header className="rd-card-head">
          <h2 id="wr-blocks-title" className="ds-serif">{view.today ? t("今天开始过的块") : t("那天开始过的块")}</h2>
          <small>{t("一键记录，写法与完成确认相同")}</small>
          {bulk.length > 1 && <button type="button" className="secondary-button rd-icon-text" disabled={Boolean(busy)} onClick={() => void allDone()}>
            <CheckCheck {...ICON} />{t("计时过的块全部按预估完成")}</button>}
        </header>
        {view.rows.length ? <ul className="wr-rows">{view.rows.map((row) => <Block key={row.blockId} row={row} label={row.line ? labels[row.line] : undefined}
          chosen={answers[row.blockId]} disabled={Boolean(busy)} timed={timed(row.timedMinutes)} onAnswer={(outcome) => void answer(row.blockId, outcome)} />)}</ul>
          : <p className="rd-empty-line">{view.today ? t("今天没有开始过的工作块；没开始的已顺延，不用记。") : t("那天没有开始过的工作块。")}</p>}
        {failed && <p role="alert" className="rd-alert">{t("没有成功，请稍后再试。")}</p>}
      </section>

      <div className="wr-side">
        <section className="rd-card" aria-labelledby="wr-all-title">
          <header className="rd-card-head"><h2 id="wr-all-title" className="ds-serif"><Sparkles {...ICON} />{t("可按推荐处理")}</h2></header>
          <AnswerAll />
          <p className="rd-note">{t("需要本人回答的问题留在待确认，明早简报会再列一次。")} <a href="/approvals#asks">{t("去待确认")}</a></p>
        </section>
        {view.today && <section className="rd-card" aria-labelledby="wr-next-title">
          <header className="rd-card-head"><h2 id="wr-next-title" className="ds-serif">{t("明天")}</h2><a href="/">{t("打开今日")}</a></header>
          {tomorrow.length ? <ul className="wr-next">{tomorrow.map((block) => <li key={`${block.start}-${block.title}`}>
            <span className="ds-serif">{block.start}</span>
            {block.line && labels[block.line] && <LineTag line={block.line}>{labels[block.line]}</LineTag>}
            <span className="wr-next-title" title={block.step ? `${block.title} · ${block.step}` : block.title}>{block.title}</span>
          </li>)}</ul> : <p className="rd-empty-line">{t("明天还没有排给工作的块。")}</p>}
        </section>}
      </div>
    </div>
  </>;
}

/** One block: its time and timer, line, task and step, and the three-part control (the chosen one filled). */
function Block({ row, label, chosen, disabled, timed, onAnswer }: { row: WrapRow; label: string | undefined; chosen: WrapOutcome | undefined;
  disabled: boolean; timed: string; onAnswer: (outcome: WrapOutcome) => void }) {
  const t = useT();
  return <li data-line={row.line ?? "none"}>
    <div className="wr-when"><b className="ds-serif">{row.start}–{row.end}</b><small>{timed}</small></div>
    <div className="wr-what">
      <div className="wr-title">{label && <LineTag line={row.line}>{label}</LineTag>}
        <a href={`/workbench/${encodeURIComponent(row.orderId)}`} title={row.title}>{row.title}</a></div>
      {row.step && <small>{row.step}</small>}
      {chosen && <small className="wr-answered" role="status">{t(ANSWERED[chosen])}</small>}
    </div>
    <div className="wr-choices" role="group" aria-label={t("{{title}} 做得怎么样", { title: row.title })}>
      {OUTCOMES.map((item) => {
        const Icon = item.icon;
        return <button key={item.id} type="button" aria-pressed={chosen === item.id} disabled={disabled || Boolean(chosen)} onClick={() => onAnswer(item.id)}>
          <Icon {...ICON} />{t(item.label)}</button>;
      })}
    </div>
  </li>;
}
