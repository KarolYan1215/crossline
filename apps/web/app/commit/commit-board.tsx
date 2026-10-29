"use client";

import { useState, type ReactNode } from "react";
import { Check, Eye, GripVertical, History, Scissors, SkipForward } from "lucide-react";
import { COMMIT_GROUPS, deferTarget, groupMinutes, type CommitGroup } from "@crossline/core";
import type { CommitRow, WeeklyCommitView } from "../../lib/weekly-commit";
import { formatMinutes } from "../ui/controls";
import { LineTag } from "../ui/tag";
import { ICON, IconButton } from "../ui/icon-button";
import { useLocale, useT } from "../locale-context";
import { monthDay } from "../../lib/i18n";
import { PENDING_CHANGED } from "../pending-badge";
import { Figure, RitualHead } from "../ritual-head";

type Preview = { keptMinutes: number; impact: { week: { unplacedBefore: number; unplacedAfter: number }; milestones: Array<{ id: string; title: string; shiftDays: number; atRiskAfter: boolean }> } };

/** Why the row was suggested where it is, in words. */
const REASON: Record<string, string> = {
  started: "已开始", due: "本周截止", fits: "排得下", over_capacity: "本周排不下", stale: "逾期一周以上且未开始"
};
/** Each group's column: its heading and the icon its move button carries elsewhere. */
const COLUMN: Record<CommitGroup, { title: string; move: string; icon: ReactNode }> = {
  keep: { title: "保", move: "改为保", icon: <Check {...ICON} /> },
  defer: { title: "推到下周", move: "推到下周", icon: <SkipForward {...ICON} /> },
  drop: { title: "不做了", move: "不做了", icon: <Scissors {...ICON} /> }
};
const hours = (minutes: number) => Math.round(minutes / 6) / 10;

/**
 * The weekly commitment's page (docs/rituals.md; the 2026-10-28 redesign after `docs/plans/page-drafts-1028/commit.html`): the week's
 * usable hours, its demand and what is kept as three figures over one bar that marks the usable line and hatches what runs past it; one
 * line about last week linking to the weekly review; then 保 / 推到下周 / 不做了 as three columns, each row with why it was suggested there
 * and buttons to move it to the other two. 「预览影响」 runs the schedule and forecast with the choices; 「确认本周」 writes them in one
 * undoable step; 「这周不调整」 records the week as committed with nothing moved.
 */
export function CommitBoard({ view, labels }: { view: WeeklyCommitView; labels: Record<string, string> }) {
  const t = useT(), locale = useLocale();
  const [groups, setGroups] = useState<Record<string, CommitGroup>>(() => Object.fromEntries(view.rows.map((row) => [row.id, row.suggestion.group])));
  const [preview, setPreview] = useState<Preview | undefined>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ deferred: number; dropped: number; opId?: string; undone?: boolean; kept?: boolean } | undefined>();
  const [failed, setFailed] = useState(false);
  const kept = groupMinutes(view.rows, groups, "keep");
  const over = Math.max(0, kept - view.capacityMinutes);
  const minutes = (value: number) => formatMinutes(Math.round(value), locale);
  const day = (value: string) => monthDay(locale, value);
  const choose = (id: string, group: CommitGroup) => { setGroups({ ...groups, [id]: group }); setPreview(undefined); };

  const post = async (action: "preview" | "apply" | "keep") => {
    setBusy(true);
    setFailed(false);
    const response = await fetch("/api/commit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, groups }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as ({ ok?: boolean; deferred?: number; dropped?: number; op?: { id: string } } & Partial<Preview>) | undefined;
    setBusy(false);
    if (!body?.ok) { setFailed(true); return; }
    if (action === "preview") { setPreview({ keptMinutes: body.keptMinutes ?? kept, impact: body.impact! }); return; }
    setDone({ deferred: body.deferred ?? 0, dropped: body.dropped ?? 0, ...(body.op ? { opId: body.op.id } : {}), ...(action === "keep" ? { kept: true } : {}) });
    window.dispatchEvent(new Event(PENDING_CHANGED));
  };
  const undo = async () => {
    if (!done?.opId) return;
    setBusy(true);
    const response = await fetch("/api/ops", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: done.opId }) }).catch(() => undefined);
    setBusy(false);
    if (response?.ok) { setDone({ ...done, undone: true }); window.dispatchEvent(new Event(PENDING_CHANGED)); }
  };

  const sub = view.due === "overload" ? t("这周新增的工作超出了可用时间。按建议保、推、砍，或逐项改。")
    : t("{{from}}–{{to}} · 先定下要做的，排不下的推到下周或不做", { from: day(view.week), to: day(view.weekEnd) });
  const title = t("本周承诺");

  if (done) return <>
    <RitualHead title={title} sub={sub} />
    <section className="rd-card rd-done" aria-live="polite">
      <p>{done.undone ? t("已撤销本周承诺，任务回到原来的安排。") : done.kept ? t("本周不调整，排程照旧。")
        : t("本周已定：推后 {{deferred}} 项，砍掉 {{dropped}} 项（在已归档里可恢复）。", { deferred: done.deferred, dropped: done.dropped })}</p>
      <div className="rd-actions">
        {done.opId && !done.undone && <button type="button" className="secondary-button" disabled={busy} onClick={() => void undo()}>{t("撤销")}</button>}
        <a className="text-button" href="/">{t("回到今日")}</a>
      </div>
    </section>
  </>;

  const empty = !view.rows.length;
  // The bar's scale holds the larger of what is usable and what is kept, so the usable line and the overflow are both on it.
  const scale = Math.max(view.capacityMinutes, kept, 1);
  const keptWithin = Math.min(kept, view.capacityMinutes);
  const recap = view.lastWeek;
  return <>
    <RitualHead title={title} sub={sub} actions={<>
      {!empty && <button type="button" className="secondary-button rd-icon-text" disabled={busy} onClick={() => void post("preview")}><Eye {...ICON} />{t("预览影响")}</button>}
      {!empty && <button type="button" className="text-button" disabled={busy} onClick={() => void post("keep")}>{t("这周不调整")}</button>}
      <button type="button" className="primary-button rd-icon-text" disabled={busy} onClick={() => void post("apply")}><Check {...ICON} />{t("确认本周")}</button>
    </>} />

    <section className="rd-card cm-capacity" aria-label={t("本周容量")}>
      <div className="cm-figures">
        <div><span className="rd-label">{t("本周可用")}</span><Figure value={hours(view.capacityMinutes)} unit="h" /></div>
        <div><span className="rd-label">{t("本周需求")}</span><Figure value={hours(view.demandMinutes)} unit="h" {...(view.demandMinutes > view.capacityMinutes ? { tone: "alarm" as const } : {})} /></div>
        <div><span className="rd-label">{t("保留后")}</span><Figure value={hours(kept)} unit="h" {...(over ? { tone: "alarm" as const } : {})} /></div>
      </div>
      <div className="cm-meter" role="img" aria-label={t("本周可用 {{usable}}，保留 {{kept}}，原有 {{demand}}", { usable: minutes(view.capacityMinutes), kept: minutes(kept), demand: minutes(view.demandMinutes) })}>
        <div className="cm-meter-labels">
          <span>{t("已保留 {{kept}}", { kept: minutes(kept) })}</span>
          <span>{over ? t("可用线 {{usable}} · 超出 {{over}}", { usable: minutes(view.capacityMinutes), over: minutes(over) }) : t("可用线 {{usable}} · 还空 {{left}}", { usable: minutes(view.capacityMinutes), left: minutes(view.capacityMinutes - kept) })}</span>
        </div>
        <div className="cm-meter-bar">
          <span className="cm-meter-kept" style={{ width: `${keptWithin / scale * 100}%` }} />
          {over > 0 && <span className="cm-meter-over" style={{ left: `${view.capacityMinutes / scale * 100}%`, width: `${over / scale * 100}%` }} />}
          <span className="cm-meter-line" style={{ left: `${view.capacityMinutes / scale * 100}%` }} aria-hidden="true" />
        </div>
        {over > 0 && <p className="rd-warn">{t("保留的比可用的多 {{over}}，这周可能做不完。", { over: minutes(over) })}</p>}
      </div>
      {recap && <a className="cm-recap" href="/review">
        <History {...ICON} />
        <span>{recap.committed
          ? t("上周承诺保留 {{kept}} · 推 {{deferred}} 项 · 砍 {{dropped}} 项 · 完成 {{accepted}} 件", { kept: minutes(recap.keptMinutes), deferred: recap.deferred, dropped: recap.dropped, accepted: recap.accepted })
          : t("上周没有确认承诺 · 完成 {{accepted}} 件", { accepted: recap.accepted })}</span>
        <u>{t("上周详情在周复盘 →")}</u>
      </a>}
    </section>

    {empty ? <section className="rd-card rd-empty">
      <p>{t("这周没有截止、已开始或排程器排上的工作，不需要保、推或砍。")}</p>
      <p className="muted">{t("「确认本周」把这周记为已承诺，这周不会再问；新增的工作超出可用时间时会再问一次。")}</p>
    </section>
      : <div className="cm-columns">{COMMIT_GROUPS.map((group) => {
        const rows = view.rows.filter((row) => (groups[row.id] ?? "keep") === group);
        return <section key={group} className="rd-card cm-column" data-group={group} aria-label={t(COLUMN[group].title)}>
          <header className="cm-column-head">
            {COLUMN[group].icon}<h2>{t(COLUMN[group].title)}</h2>
            <small>{t("{{count}} 项 · {{time}}", { count: rows.length, time: minutes(rows.reduce((sum, row) => sum + row.minutes, 0)) })}</small>
          </header>
          {rows.length ? <ul className="cm-rows">{rows.map((row) => rowOf(row, group))}</ul>
            : <p className="cm-none">{t(group === "keep" ? "没有保留的任务" : group === "defer" ? "没有推到下周的任务" : "没有不做的任务")}</p>}
          {group === "drop" && rows.length > 0 && <p className="cm-foot">{t("归档原因「本周承诺：不做了」，可从已归档恢复")}</p>}
        </section>;
      })}</div>}

    {preview && <section className="rd-card rd-preview" aria-live="polite">
      <h2>{t("确认后的影响")}</h2>
      <p>{t("确认后：未排进日历的任务 {{before}} → {{after}} 个。", { before: preview.impact.week.unplacedBefore, after: preview.impact.week.unplacedAfter })}</p>
      {preview.impact.milestones.length > 0 && <ul>{preview.impact.milestones.slice(0, 6).map((item) => <li key={item.id}>
        {item.shiftDays > 0 ? t("「{{title}}」保守完成日推后 {{count}} 天", { title: item.title, count: item.shiftDays })
          : item.shiftDays < 0 ? t("「{{title}}」保守完成日提前 {{count}} 天", { title: item.title, count: -item.shiftDays })
          : t("「{{title}}」风险有变化", { title: item.title })}
        {item.atRiskAfter ? ` · ${t("仍有风险")}` : ""}
      </li>)}</ul>}
    </section>}
    {failed && <p role="alert" className="rd-alert">{t("没有成功，请稍后再试。")}</p>}
  </>;

  /** One task in its column: line, title, time and due day (a pushed one's new days), why it is there, and moves to the other two. */
  function rowOf(row: CommitRow, group: CommitGroup) {
    const label = labels[row.line];
    const target = group === "defer" ? deferTarget(row, view.week) : undefined;
    const due = row.dueDay ? (row.overdueDays ? t("逾期 {{count}} 天", { count: row.overdueDays }) : t("{{day}} 截止", { day: day(row.dueDay) })) : t("无截止");
    const meta = [minutes(row.minutes),
      target ? (target.dueDay ? t("从 {{from}} 起排，截止改到 {{due}}", { from: day(target.notBefore), due: day(target.dueDay) }) : t("从 {{from}} 起排", { from: day(target.notBefore) })) : due,
      row.started ? t("已开始") : ""].filter(Boolean).join(" · ");
    const moved = row.suggestion.group !== group;
    return <li key={row.id} data-line={row.line}>
      <span className="cm-grip" aria-hidden="true"><GripVertical {...ICON} /></span>
      <div className="cm-row-main">
        <div className="cm-row-title">{label && <LineTag line={row.line}>{label}</LineTag>}
          <a href={`/workbench/${encodeURIComponent(row.id)}`} title={row.title}>{row.title}</a></div>
        <small>{meta}</small>
        <small className="cm-reason">{moved ? t("本人改到这里；建议{{group}}：{{reason}}", { group: t(COLUMN[row.suggestion.group].title), reason: t(REASON[row.suggestion.reason]!) })
          : t("理由：{{reason}}", { reason: t(REASON[row.suggestion.reason]!) })}{row.weight !== 50 ? ` · ${t("里程碑重要性 {{weight}}", { weight: Math.round(row.weight) })}` : ""}</small>
      </div>
      <span className="cm-row-moves">{COMMIT_GROUPS.filter((other) => other !== group).map((other) =>
        <IconButton key={other} label={t("「{{title}}」{{move}}", { title: row.title, move: t(COLUMN[other].move) })} icon={COLUMN[other].icon} disabled={busy}
          className="cm-move" onClick={() => choose(row.id, other)} />)}</span>
    </li>;
  }
}
