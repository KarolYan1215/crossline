"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";

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
  const [status, setStatus] = useState("");
  const change = async (next: Level) => {
    const previous = value;
    setValue(next);
    const response = await fetch("/api/settings/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: next }) }).catch(() => null);
    if (!response?.ok) setValue(previous);
    setStatus(response?.ok ? "已保存" : "未保存");
  };
  return <div className="st-row"><span className="st-row-label">推送档位<small>{OPTIONS.find((option) => option.value === value)?.title}</small></span>
    <SegmentedControl label="推送档位" value={value} onChange={(next) => void change(next)} options={OPTIONS.map(({ value: v, label, title }) => ({ value: v, label, title }))} />
    {status && <small role="status" className={status === "已保存" ? "st-ok" : "st-fail"}>{status}</small>}
  </div>;
}
