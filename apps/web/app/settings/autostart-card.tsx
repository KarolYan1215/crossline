"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";

/** Starting with Windows, on an installed copy: off until the person turns it on. */
export function AutostartCard({ on }: { on: boolean }) {
  const [value, setValue] = useState(on);
  const [note, setNote] = useState("");
  const change = async (next: boolean) => {
    setValue(next);
    const response = await fetch("/api/settings/autostart", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on: next }) }).catch(() => undefined);
    if (!response?.ok) { setValue(!next); setNote("未保存，请重试"); } else setNote(next ? "已开启：登录 Windows 后在后台启动，托盘里可以打开" : "已关闭");
  };
  return <section className="st-card" aria-label="开机自启">
    <header><h3>开机自启</h3><small>登录 Windows 后自动在后台运行，提醒和日历同步不中断</small></header>
    <div className="st-row"><span className="st-row-label">开机时启动<small>{value ? "开启" : "关闭"}</small></span>
      <SegmentedControl label="开机时启动" value={value ? "on" : "off"} onChange={(next) => void change(next === "on")}
        options={[{ value: "off", label: "关闭" }, { value: "on", label: "开启" }]} /></div>
    {note && <p role="status" className="st-note">{note}</p>}
  </section>;
}
