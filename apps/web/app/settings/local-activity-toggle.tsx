"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { BarChart } from "../ui/charts";
import { useLocale, useT } from "../locale-context";
import { intlLocale } from "../../lib/i18n";

type Level = "granted" | "denied" | "unasked";
type Entry = { start: string; end: string; app: string; title: string; category: string; idle: boolean };
type Privacy = "off" | "minutes" | "detail";

const send = (body: Record<string, unknown>) => fetch("/api/settings/local-activity", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
});
const PRIVACY: Record<Privacy, { body: Record<string, unknown>; label: string; title: string }> = {
  off: { body: { consent: "denied" }, label: "关闭", title: "不读取屏幕活动" },
  minutes: { body: { consent: "granted", detail: "denied" }, label: "只记分钟", title: "只记每天的活跃分钟数，不记应用与窗口" },
  detail: { body: { detail: "granted" }, label: "应用与窗口", title: "记录应用与窗口标题；标题只存本机，14 天后抹除，不发给模型" }
};

/**
 * Screen activity and its privacy in one module: the level (off / minutes only / apps and windows), a pause, the person's own
 * never-record words, today's activity drawn from what is kept, and the one place stored window titles can be read and wiped.
 */
export function LocalActivityToggle({ consent, detail, pausedUntil, blacklist, hours, categories }: {
  consent: Level; detail: Level; pausedUntil: string | null; blacklist: string[];
  /** Today's active minutes per hour (24) and per category, from the kept segments; empty without the detailed level. */
  hours: number[]; categories: Array<{ label: string; minutes: number }>;
}) {
  const t = useT();
  const locale = useLocale();
  const [level, setLevel] = useState<Privacy>(detail === "granted" ? "detail" : consent === "granted" ? "minutes" : "off");
  const [paused, setPaused] = useState(pausedUntil && Date.parse(pausedUntil) > Date.now() ? pausedUntil : null);
  const [words, setWords] = useState<string[]>(blacklist);
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [note, setNote] = useState("");

  const save = async (body: Record<string, unknown>, done: string) => {
    const response = await send(body).catch(() => undefined);
    setNote(response?.ok ? done : t("未保存，请重试"));
    return Boolean(response?.ok);
  };
  const changeLevel = async (next: Privacy) => {
    const previous = level;
    setLevel(next);
    if (!await save(PRIVACY[next].body, t("已保存"))) setLevel(previous);
  };
  const pause = async (minutes: number) => {
    if (await save({ pauseMinutes: minutes }, minutes ? t("已暂停") : t("已恢复"))) setPaused(minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null);
  };
  const saveWords = async (next: string[]) => { if (await save({ blacklist: next }, t("已保存"))) setWords(next); };
  const clock = (iso: string) => new Date(iso).toLocaleString(intlLocale(locale), { hour12: false, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
  const top = Math.max(1, ...hours);

  return <div className="st-modules">
    <section className="st-card" aria-label={t("记录级别")}>
      <header><h3>{t("记录级别")}</h3><small>{t("不记录按键、不截屏、不上传；银行、密码管理器、无痕窗口不记录")}</small></header>
      <div className="st-row"><span className="st-row-label">{t("屏幕活动")}<small>{t(PRIVACY[level].title)}</small></span>
        <SegmentedControl label={t("屏幕活动记录级别")} value={level} onChange={(value) => void changeLevel(value)}
          options={(Object.keys(PRIVACY) as Privacy[]).map((key) => ({ value: key, label: t(PRIVACY[key].label, { context: "state" }), title: t(PRIVACY[key].title) }))} /></div>
      {level !== "off" && <div className="st-row"><span className="st-row-label">{t("暂停")}<small>{paused ? t("暂停至 {{when}}", { when: clock(paused) }) : t("正在记录")}</small></span>
        <SegmentedControl label={t("暂停记录")} value={paused ? "paused" : "on"} onChange={(value) => void pause(value === "on" ? 0 : value === "p1" ? 60 : value === "p4" ? 240 : 1440)}
          options={[{ value: "on", label: t("记录中") }, { value: "p1", label: t("1 小时") }, { value: "p4", label: t("4 小时") }, { value: "p24", label: t("到明天") }]} /></div>}
      <div className="st-row st-row-wrap"><span className="st-row-label">{t("不记录的词")}<small>{t("窗口标题或应用名包含即整条跳过")}</small></span>
        <span className="st-chips">{words.map((word) => <button key={word} type="button" className="st-chip" aria-label={t("移除「{{word}}」", { word })}
          onClick={() => void saveWords(words.filter((item) => item !== word))}>{word} ×</button>)}
          <input value={draft} placeholder={t("添加…")} aria-label={t("添加不记录的词")} onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && draft.trim()) { event.preventDefault(); void saveWords([...new Set([...words, draft.trim()])]); setDraft(""); } }} /></span></div>
      {note && <p role="status" className="st-note">{note}</p>}
    </section>
    {level === "detail" && hours.some(Boolean) && <section className="st-card" aria-label={t("今日活动")}>
      <header><h3>{t("今日活动")}</h3><small>{t("{{minutes}} 分钟活跃", { minutes: Math.round(hours.reduce((sum, value) => sum + value, 0)) })}</small></header>
      <div className="st-hours" role="img" aria-label={t("今日每小时活跃分钟")}>{hours.map((minutes, hour) =>
        <span key={hour} title={t("{{from}}:00–{{to}}:00 · {{minutes}} 分钟", { from: hour, to: hour + 1, minutes: Math.round(minutes) })}><i style={{ height: `${(minutes / top) * 100}%` }} /></span>)}</div>
      <div className="st-hours-axis" aria-hidden="true"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
      {categories.length > 0 && <BarChart label={t("今日按类别")} unit={t(" 分")} data={categories.map((item) => ({ label: item.label, value: Math.round(item.minutes) }))} />}
    </section>}
    {level === "detail" && <section className="st-card" aria-label={t("已存记录")}>
      <header><h3>{t("已存记录")}</h3><small>{t("窗口标题仅存本机")}</small></header>
      <div className="st-row">
        <button type="button" onClick={async () => {
          const response = await fetch("/api/settings/local-activity").catch(() => undefined);
          if (!response?.ok) { setNote(t("读取失败")); return; }
          setEntries(((await response.json()) as { entries: Entry[] }).entries);
        }}>{t("查看最近记录")}</button>
        <button type="button" onClick={async () => { if (await save({ clearTitles: true }, t("已清除所有窗口标题"))) setEntries((current) => current?.map((entry) => ({ ...entry, title: "" })) ?? null); }}>
          {t("清除所有窗口标题")}</button>
      </div>
      {entries && (entries.length ? <ul className="st-list">{entries.map((entry) => <li key={`${entry.start}-${entry.app}`}>
        <small className="mono">{clock(entry.start)}</small><span>{entry.idle ? t("离开") : entry.app}</span><small>{entry.title || t("（无标题）")}</small></li>)}</ul>
        : <p className="muted">{t("暂无记录。")}</p>)}
    </section>}
  </div>;
}
