"use client";

import { useState } from "react";

/** Unlike `LocalActivityConsent` (a one-time prompt that disappears once answered), this shows the
 * current value and lets it be changed later — the gap `/settings` exists to close: the prompt had no
 * way back to it. */
export function LocalActivityToggle({ consent }: { consent: "granted" | "denied" | "unasked" }) {
  const [current, setCurrent] = useState(consent);
  const [busy, setBusy] = useState(false);
  const set = async (next: "granted" | "denied") => {
    setBusy(true);
    const response = await fetch("/api/settings/local-activity", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ consent: next })
    });
    setBusy(false);
    if (response.ok) setCurrent(next);
  };
  const label = { granted: "已开启", denied: "已关闭", unasked: "尚未设置" }[current];
  return <div className="settings-row">
    <span>本机活动采集：{label}</span>
    <div className="settings-row-actions">
      <button type="button" className="secondary-button" disabled={busy || current === "granted"} onClick={() => void set("granted")}>开启</button>
      <button type="button" className="secondary-button" disabled={busy || current === "denied"} onClick={() => void set("denied")}>关闭</button>
    </div>
  </div>;
}
