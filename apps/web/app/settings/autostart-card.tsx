"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { useT } from "../locale-context";

/** Starting with Windows, on an installed copy: off until the person turns it on. */
export function AutostartCard({ on }: { on: boolean }) {
  const t = useT();
  const [value, setValue] = useState(on);
  const [note, setNote] = useState("");
  const change = async (next: boolean) => {
    setValue(next);
    const response = await fetch("/api/settings/autostart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: next }) }).catch(() => undefined);
    if (!response?.ok) { setValue(!next); setNote(t("未保存，请重试")); } else setNote(next ? t("已开启：登录 Windows 后在后台启动，托盘里可以打开") : t("已关闭"));
  };
  return <section className="st-card" aria-label={t("开机自启")}>
    <header><h3>{t("开机自启")}</h3><small>{t("登录 Windows 后自动在后台运行，提醒和日历同步不中断")}</small></header>
    <div className="st-row"><span className="st-row-label">{t("开机时启动")}<small>{value ? t("开启", { context: "state" }) : t("关闭", { context: "state" })}</small></span>
      <SegmentedControl label={t("开机时启动")} value={value ? "on" : "off"} onChange={(next) => void change(next === "on")}
        options={[{ value: "off", label: t("关闭", { context: "state" }) }, { value: "on", label: t("开启", { context: "state" }) }]} /></div>
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}
