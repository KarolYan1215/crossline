"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { useT } from "../locale-context";

const OPTIONS = [
  { value: "off", label: "关闭", title: "不发桌面与手机通知" },
  { value: "less", label: "少", title: "只发早报" },
  { value: "normal", label: "标准", title: "早报 + 当日到期事项，每天最多 2 条" },
  { value: "more", label: "多", title: "早报 + 当日到期事项，每天最多 5 条" }
] as const;
type Level = (typeof OPTIONS)[number]["value"];

/** The one dial for desktop and phone notifications. Work-block reminders come from the Crossline calendar, not from here. */
export function NotifyLevel({ level }: { level: string }) {
  const [value, setValue] = useState<Level>(OPTIONS.some((option) => option.value === level) ? level as Level : "normal");
  const t = useT();
  const [status, setStatus] = useState<"" | "saved" | "failed">("");
  const change = async (next: Level) => {
    const previous = value;
    setValue(next);
    const response = await fetch("/api/settings/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: next }) }).catch(() => null);
    if (!response?.ok) setValue(previous);
    setStatus(response?.ok ? "saved" : "failed");
  };
  const title = OPTIONS.find((option) => option.value === value)?.title;
  return <div className="st-row"><span className="st-row-label">{t("推送档位")}<small>{title && t(title)}</small></span>
    <SegmentedControl label={t("推送档位")} value={value} onChange={(next) => void change(next)} options={OPTIONS.map(({ value: v, label, title }) => ({ value: v, label: t(label, { context: "state" }), title: t(title) }))} />
    {status && <small role="status" className={status === "saved" ? "st-ok" : "st-fail"}>{status === "saved" ? t("已保存") : t("未保存")}</small>}
  </div>;
}

/**
 * The quiet hours and the morning brief's time (2026-10-30): set here, by the input box, or from what the person said in the interview.
 * Native time inputs; each saves on change and goes back if the save fails.
 */
export function NotifyTimes({ quiet, brief }: { quiet: string; brief: string }) {
  const t = useT();
  const [from0 = "23:00", to0 = "08:00"] = quiet.split("-");
  const [range, setRange] = useState({ from: from0, to: to0 });
  const [briefAt, setBriefAt] = useState(brief);
  const [status, setStatus] = useState<"" | "saved" | "failed">("");
  const save = async (body: Record<string, string>, undo: () => void) => {
    const response = await fetch("/api/settings/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
    if (!response?.ok) undo();
    setStatus(response?.ok ? "saved" : "failed");
  };
  const changeRange = (next: { from: string; to: string }) => {
    const previous = range;
    setRange(next);
    if (next.from && next.to) void save({ quietHours: `${next.from}-${next.to}` }, () => setRange(previous));
  };
  const changeBrief = (next: string) => {
    const previous = briefAt;
    setBriefAt(next);
    void save({ briefTime: next }, () => setBriefAt(previous));
  };
  return <>
    <div className="st-row"><span className="st-row-label">{t("免打扰时段")}<small>{t("这段时间不发提醒，只有本人刚开始的事例外；可跨零点")}</small></span>
      <span className="st-time-range">
        <input type="time" aria-label={t("免打扰开始")} value={range.from} onChange={(event) => changeRange({ ...range, from: event.target.value })} />
        <span aria-hidden>–</span>
        <input type="time" aria-label={t("免打扰结束")} value={range.to} onChange={(event) => changeRange({ ...range, to: event.target.value })} />
      </span></div>
    <div className="st-row"><span className="st-row-label">{t("晨间简报时间")}<small>{t("留空则从当天第一个可用时段起")}</small></span>
      <input type="time" aria-label={t("晨间简报时间")} value={briefAt} onChange={(event) => changeBrief(event.target.value)} />
      {status && <small role="status" className={status === "saved" ? "st-ok" : "st-fail"}>{status === "saved" ? t("已保存") : t("未保存")}</small>}</div>
  </>;
}
