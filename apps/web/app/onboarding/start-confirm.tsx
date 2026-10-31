"use client";

import { useState } from "react";
import { Sheet } from "../ui/overlay";
import { useT } from "../locale-context";
import type { StartSummary } from "../../lib/start-confirm";

const SOURCE: Record<StartSummary["hours"]["source"], string> = {
  saved: "本人在计划页设置", interview: "按访谈中所说推定", stated_hours: "按所说的每周总时长平均分配", default: "默认时段"
};

/**
 * The one look before the app opens (2026-10-19): the lines with their goals and current projects, the weekly hours and the fixed
 * schedule the first plan rests on. Something wrong is told to the interview in its own box; 「确认无误」 opens every page.
 */
export function StartConfirm({ summary }: { summary: StartSummary }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The settings stated in the interview, all ticked: unticking one leaves that setting as it is.
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const toggle = (id: string) => setSkip((current) => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; });
  const confirm = async () => {
    setBusy(true); setError("");
    const response = await fetch("/api/onboarding/start-confirm", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ skip: [...skip] }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { ok?: boolean; code?: string } | undefined;
    setBusy(false);
    if (body?.ok) { location.assign("/"); return; }
    setError(body?.code === "START_STILL_ORGANIZING" ? t("刚才的回答还在整理，稍等片刻再确认。") : t("没有保存成功，请再试一次。"));
  };
  return <>
    <button type="button" className="ob-btn ob-primary" onClick={() => setOpen(true)}>{t("核对后开始使用")}</button>
    <Sheet title={t("开始使用前核对一遍")} open={open} onOpenChange={setOpen}
      footer={<>
        {error && <p className="ob-start-error" role="alert">{error}</p>}
        <button type="button" className="ob-btn" onClick={() => setOpen(false)}>{t("有要改的，回到访谈")}</button>
        <button type="button" className="ob-btn ob-primary" disabled={busy} onClick={() => void confirm()}>{busy ? t("保存中…") : t("确认无误，开始使用")}</button>
      </>}>
      <div className="ob-start-confirm">
        <p className="ob-muted">{t("第一份日程按下面这些内容排。哪里不对，回到访谈在对话框里直接说，访谈会改。")}</p>
        <section aria-label={t("主线")}>
          <h3>{t("主线")}</h3>
          {summary.lines.map((line) => <div key={line.id} className="ob-start-line" data-line={line.id}>
            <b>{line.hard ? t("{{line}}（固定日程优先）", { line: line.label }) : line.label}</b>
            {line.description && <p className="gen">{line.description}</p>}
            <p>{line.goal ? t("长期目标：{{goal}}", { goal: line.goal }) : t("长期目标：未采用")}</p>
            <ul>{line.projects.length ? line.projects.map((project) => <li key={project.name}>{project.deadline ? t("{{name}}：{{deadline}}", { name: project.name, deadline: project.deadline }) : t("{{name}}：截止未记录", { name: project.name })}</li>)
              : <li>{t("暂无当前项目")}</li>}</ul>
          </div>)}
        </section>
        <section aria-label={t("每周可用时段")}>
          <h3>{t("每周可用时段：约 {{hours}} 小时", { hours: summary.hours.weekly })}</h3>
          <p className="ob-muted">{t(SOURCE[summary.hours.source])}</p>
          <ul>{summary.hours.windows.map((window) => <li key={window}>{window}</li>)}</ul>
        </section>
        {summary.settings.length > 0 && <section aria-label={t("访谈中说到的设置")}>
          <h3>{t("访谈中说到的设置")}</h3>
          <p className="ob-muted">{t("勾选的在开始使用时生效，之后可在设置页改。")}</p>
          <ul className="ob-start-settings">{summary.settings.map((item) => <li key={item.id}><label>
            <input type="checkbox" checked={!skip.has(item.id)} onChange={() => toggle(item.id)} />
            <span><b>{item.label}</b>{t("：{{value}}", { value: item.to })}{item.quote && <small className="gen">{t("依据：「{{quote}}」", { quote: item.quote })}</small>}</span>
          </label></li>)}</ul>
        </section>}
        <section aria-label={t("固定日程")}>
          <h3>{t("固定日程：{{count}} 项", { count: summary.fixed.count })}</h3>
          {summary.fixed.count > 0 ? <ul>{summary.fixed.items.map((item) => <li key={item}>{item}</li>)}
            {summary.fixed.count > summary.fixed.items.length && <li>{t("等 {{count}} 项", { count: summary.fixed.count - summary.fixed.items.length })}</li>}</ul>
            : <p className="ob-muted">{t("没有读到每周固定的课或会。")}</p>}
        </section>
      </div>
    </Sheet>
  </>;
}
