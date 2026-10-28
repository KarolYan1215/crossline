"use client";

import { useState } from "react";
import { COMMIT_GROUP_LABEL, COMMIT_GROUPS, deferTarget, groupMinutes, type CommitGroup } from "@crossline/core";
import type { WeeklyCommitView } from "../../lib/weekly-commit";
import { SegmentedControl, formatMinutes } from "../ui/controls";
import { useLocale, useT } from "../locale-context";
import { monthDay } from "../../lib/i18n";
import { PENDING_CHANGED } from "../pending-badge";

type Preview = { keptMinutes: number; impact: { week: { unplacedBefore: number; unplacedAfter: number }; milestones: Array<{ id: string; title: string; shiftDays: number; atRiskAfter: boolean }> } };

const REASON: Record<string, string> = {
  started: "已开始", due: "本周截止", fits: "排得下", over_capacity: "本周排不下", stale: "逾期一周以上且未开始"
};

/**
 * The weekly commitment's page (docs/rituals.md): the week's usable hours against its work as one bar, then every task with 保 / 推 / 砍
 * (the suggestion preselected, its reason beside it). 「预览影响」 runs the schedule and forecast with the choices; 「确认本周」 writes them
 * in one undoable step.
 */
export function CommitBoard({ view }: { view: WeeklyCommitView }) {
  const t = useT(), locale = useLocale();
  const [groups, setGroups] = useState<Record<string, CommitGroup>>(() => Object.fromEntries(view.rows.map((row) => [row.id, row.suggestion.group])));
  const [preview, setPreview] = useState<Preview | undefined>();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ deferred: number; dropped: number; opId?: string; undone?: boolean; kept?: boolean } | undefined>();
  const [failed, setFailed] = useState(false);
  const kept = groupMinutes(view.rows, groups, "keep");
  const over = kept > view.capacityMinutes;
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

  if (done) return <section className="ritual-card" aria-live="polite">
    <p>{done.undone ? t("已撤销本周承诺，任务回到原来的安排。") : done.kept ? t("本周不调整，排程照旧。")
      : t("本周已定：推后 {{deferred}} 项，砍掉 {{dropped}} 项（在已归档里可恢复）。", { deferred: done.deferred, dropped: done.dropped })}</p>
    <div className="ritual-actions">
      {done.opId && !done.undone && <button type="button" className="secondary-button" disabled={busy} onClick={() => void undo()}>{t("撤销")}</button>}
      <a className="text-button" href="/">{t("回到今日")}</a>
    </div>
  </section>;

  return <section className="ritual-card">
    <p className="ritual-lead">{view.due === "overload"
      ? t("这周新增的工作超出了可用时间。按建议保、推、砍，或逐项改。")
      : t("{{from}}–{{to}} 这一周：先定下要做的，排不下的推到下周或砍掉。", { from: day(view.week), to: day(view.weekEnd) })}</p>
    <div className="ritual-meter" role="img" aria-label={t("本周可用 {{usable}}，保留 {{kept}}，原有 {{demand}}", { usable: minutes(view.capacityMinutes), kept: minutes(kept), demand: minutes(view.demandMinutes) })}>
      <div className="ritual-meter-bar"><span style={{ width: `${Math.min(100, view.capacityMinutes ? kept / view.capacityMinutes * 100 : 100)}%` }} data-over={over || undefined} /></div>
      <p className="mono">{t("可用 {{usable}} · 保留 {{kept}} · 原有 {{demand}}", { usable: minutes(view.capacityMinutes), kept: minutes(kept), demand: minutes(view.demandMinutes) })}</p>
      {over && <p className="ritual-warn">{t("保留的比可用的多 {{over}}，这周可能做不完。", { over: minutes(kept - view.capacityMinutes) })}</p>}
    </div>
    {!view.rows.length ? <p className="muted">{t("这周没有截止或已排上的工作。")}</p>
      : <ul className="ritual-rows">{view.rows.map((row) => {
        const group = groups[row.id] ?? "keep";
        const target = group === "defer" ? deferTarget(row, view.week) : undefined;
        return <li key={row.id} data-line={row.line} data-group={group}>
          <div className="ritual-row-main">
            <a href={`/workbench/${encodeURIComponent(row.id)}`} title={row.title}>{row.title}</a>
            <small className="muted">
              {[minutes(row.minutes), row.dueDay ? (row.overdueDays ? t("已过截止 {{count}} 天", { count: row.overdueDays }) : t("截止 {{day}}", { day: day(row.dueDay) })) : t("无截止"),
                t("建议{{group}}：{{reason}}", { group: t(COMMIT_GROUP_LABEL[row.suggestion.group]), reason: t(REASON[row.suggestion.reason]!) })].join(" · ")}
            </small>
            {target && <small className="muted">{target.dueDay
              ? t("从 {{from}} 起排，截止改到 {{due}}", { from: day(target.notBefore), due: day(target.dueDay) })
              : t("从 {{from}} 起排", { from: day(target.notBefore) })}</small>}
            {group === "drop" && <small className="muted">{t("归档，可在任务页「已归档」恢复")}</small>}
          </div>
          <SegmentedControl label={t("「{{title}}」本周", { title: row.title })} value={group} onChange={(value) => choose(row.id, value)}
            options={COMMIT_GROUPS.map((value) => ({ value, label: t(COMMIT_GROUP_LABEL[value]) }))} />
        </li>;
      })}</ul>}
    {preview && <div className="ritual-preview" aria-live="polite">
      <p>{t("确认后：未排进日历的任务 {{before}} → {{after}} 个。", { before: preview.impact.week.unplacedBefore, after: preview.impact.week.unplacedAfter })}</p>
      {preview.impact.milestones.length > 0 && <ul>{preview.impact.milestones.slice(0, 6).map((item) => <li key={item.id}>
        {item.shiftDays > 0 ? t("「{{title}}」保守完成日推后 {{count}} 天", { title: item.title, count: item.shiftDays })
          : item.shiftDays < 0 ? t("「{{title}}」保守完成日提前 {{count}} 天", { title: item.title, count: -item.shiftDays })
          : t("「{{title}}」风险有变化", { title: item.title })}
        {item.atRiskAfter ? ` · ${t("仍有风险")}` : ""}
      </li>)}</ul>}
    </div>}
    {failed && <p role="alert">{t("没有成功，请稍后再试。")}</p>}
    <div className="ritual-actions">
      <button type="button" className="primary-button" disabled={busy} onClick={() => void post("apply")}>{t("确认本周")}</button>
      <button type="button" className="secondary-button" disabled={busy || !view.rows.length} onClick={() => void post("preview")}>{t("预览影响")}</button>
      <button type="button" className="text-button" disabled={busy} onClick={() => void post("keep")}>{t("这周不调整")}</button>
    </div>
  </section>;
}
