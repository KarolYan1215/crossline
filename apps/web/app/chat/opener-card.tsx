"use client";

import { useEffect, useState } from "react";
import { blockSpan, dayLabel, hoursText, minutesOfClock, openerAxis, workMinutes, type OpenerBlock, type OpenerView } from "../../lib/opener";
import "./opener-card.css";
import { useLocale, useT } from "../locale-context";

const URGENCY: Record<"now" | "soon" | "later", string> = { now: "两天内", soon: "本周", later: "以后" };
const md = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const clockLabel = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:00`;

/** The minute of the day in the person's zone when it is the opener's own day; undefined otherwise (or before the page has mounted). */
function useNowMinute(day: string, timeZone: string): number | undefined {
  const [minute, setMinute] = useState<number | undefined>();
  useEffect(() => {
    const read = () => {
      try {
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
          .formatToParts(new Date()).map((part) => [part.type, part.value]));
        setMinute(`${parts.year}-${parts.month}-${parts.day}` === day ? Number(parts.hour) * 60 + Number(parts.minute) : undefined);
      } catch { setMinute(undefined); }
    };
    read();
    const timer = setInterval(read, 60_000);
    return () => clearInterval(timer);
  }, [day, timeZone]);
  return minute;
}

function Lane({ label, blocks, axis, kind }: { label: string; blocks: OpenerBlock[]; axis: { from: number; to: number }; kind: "fixed" | "work" }) {
  const t = useT();
  const locale = useLocale();
  return <div className="opener-lane" data-kind={kind}>
    <span className="opener-lane-label">{t(label)}</span>
    <ul className="opener-track" aria-label={t("{{label}}：{{value}}", { label: t(label), value: blocks.length
      ? blocks.map((block) => `${block.start}–${block.end} ${block.title}${block.step ? ` · ${block.step}` : ""}`).join(locale === "en" ? "; " : "；") : t("无") })}>
      {blocks.map((block, index) => {
        const { left, width } = blockSpan(block, axis);
        return <li key={`${block.start}-${index}`} className="opener-block" data-line={block.line ?? "none"} style={{ left: `${left}%`, width: `${width}%` }}
          title={`${block.start}–${block.end} ${block.title}${block.step ? ` · ${block.step}` : ""}`} />;
      })}
    </ul>
  </div>;
}

/**
 * The day's opener drawn rather than written: the date and a mark for the decisions waiting, one small timeline of the day (fixed
 * arrangements outlined, work filled, both in the lines' colours), the next work and the fixed arrangements in one line each, what is
 * due within three days, and the most urgent decision set apart — its answers are the card's own buttons, right under this.
 */
export function OpenerCard({ opener }: { opener: OpenerView }) {
  const t = useT();
  const locale = useLocale();
  const axis = openerAxis(opener);
  const now = useNowMinute(opener.day, opener.timeZone);
  const nextWork = (now === undefined ? opener.work : opener.work.filter((block) => minutesOfClock(block.end) > now))[0];
  const ticks: number[] = [];
  for (let minute = Math.ceil(axis.from / 180) * 180; minute <= axis.to; minute += 180) ticks.push(minute);
  const top = opener.asks.top;
  return <div className="opener-card" aria-label={t("{{day}}的安排", { day: dayLabel(opener.day, locale) })}>
    <div className="opener-head">
      <b>{dayLabel(opener.day, locale)}</b>
      {opener.asks.count > 0
        ? <a className="opener-badge" href="/approvals" aria-label={t("待决 {{count}} 项", { count: opener.asks.count })}>{t("待决")} <span>{opener.asks.count}</span></a>
        : <span className="opener-badge" data-empty="">{t("没有待决")}</span>}
    </div>
    <div className="opener-figure">
      <Lane label={"固定"} blocks={opener.fixed} axis={axis} kind="fixed" />
      <Lane label={"工作"} blocks={opener.work} axis={axis} kind="work" />
      <div className="opener-axis" aria-hidden="true">
        {ticks.map((minute) => <span key={minute} style={{ left: `${((minute - axis.from) / (axis.to - axis.from)) * 100}%` }}>{clockLabel(minute)}</span>)}
      </div>
      {now !== undefined && now >= axis.from && now <= axis.to && <span className="opener-now" aria-hidden="true"
        style={{ left: `calc(36px + (100% - 36px) * ${(now - axis.from) / (axis.to - axis.from)})` }} />}
    </div>
    <dl className="opener-facts">
      <div><dt>{t("工作")}</dt><dd>{opener.work.length ? t("{{count}} 段 · 共 {{hours}}", { count: opener.work.length, hours: hoursText(workMinutes(opener), locale) }) : t("今天没有排给工作的时段")}
        {nextWork && <span className="opener-next">{now === undefined ? t("第一段") : t("接下来")} {nextWork.start} {nextWork.title}{nextWork.step ? ` · ${nextWork.step}` : ""}</span>}</dd></div>
      <div><dt>{t("固定")}</dt><dd>{opener.fixed.length ? opener.fixed.slice(0, 2).map((block) => `${block.start}–${block.end} ${block.title}`).join(locale === "en" ? "; " : "；")
        + (opener.fixed.length > 2 ? t(" 等 {{count}} 项", { count: opener.fixed.length }) : "") : t("今天没有固定安排")}</dd></div>
      {opener.soon.length > 0 && <div><dt>{t("三天内截止")}</dt><dd><ul className="opener-soon">
        {opener.soon.map((item) => <li key={`${item.title}-${item.due}`} data-line={item.line ?? "none"}>{item.title}<small>{md(item.due)}</small></li>)}</ul></dd></div>}
    </dl>
    {top && <div className="opener-urgent" data-line={top.line ?? "none"}>
      <small>{t("最紧急 · {{when}}", { when: t(URGENCY[top.urgency]) })}</small>
      <b>{top.title}</b>
    </div>}
  </div>;
}
