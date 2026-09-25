"use client";
import { useState } from "react";

/**
 * Asked once, on Today, and only when the answer is not already recorded. Collection stays off until
 * the answer is "granted" — the same posture the removed camera path was held to.
 */
export function LocalActivityConsent({ asked }: { asked: boolean }) {
  const [done, setDone] = useState(asked);
  const [error, setError] = useState("");
  if (done) return null;
  const answer = async (consent: "granted" | "denied") => {
    const response = await fetch("/api/settings/local-activity", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ consent })
    });
    if (response.ok) { setDone(true); location.reload(); } else setError("没有保存成功，请重试。");
  };
  return <aside className="consent-ask" role="region" aria-label="本机活动采集授权">
    <p><b>要不要开启本机活动采集？</b></p>
    <p>只读取两个值：距上次输入的毫秒数，和一个不透明的窗口句柄数字。
      <b>不读取窗口标题、不记录按键、不上传任何内容</b>，只保存每天的活跃分钟数与窗口切换次数。
      它用来在你没有自评时给出参考读数；不开启也不影响任何其他功能。</p>
    <div>
      <button type="button" className="primary-button" onClick={() => void answer("granted")}>开启</button>
      <button type="button" onClick={() => void answer("denied")}>不开启</button>
      {/* Hides for this visit only — nothing is written, so the question comes back next time rather
          than being silently decided as "denied" on the person's behalf. */}
      <button type="button" onClick={() => setDone(true)}>稍后再说</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </aside>;
}
