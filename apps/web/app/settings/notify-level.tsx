"use client";

import { useState } from "react";

const OPTIONS: Array<[string, string]> = [["off", "不打扰"], ["less", "少：只有早报"], ["normal", "正常：早报 + 当天会误事的（最多 2 条）"], ["more", "多：早报 + 最多 5 条"]];

/** The one dial for desktop notifications. Work-block reminders come from the Crossline calendar, not from here. */
export function NotifyLevel({ level }: { level: string }) {
  const [value, setValue] = useState(level);
  const [status, setStatus] = useState("");
  return <label className="notify-level">桌面通知
    <select value={value} onChange={async (event) => {
      const next = event.target.value;
      setValue(next);
      const response = await fetch("/api/settings/notify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: next }) }).catch(() => null);
      setStatus(response?.ok ? "已保存" : "没保存上");
    }}>{OPTIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select>
    {status && <small role="status">{status}</small>}
  </label>;
}
