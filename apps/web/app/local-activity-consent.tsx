"use client";
import { useState } from "react";

/**
 * Asked once, on Today, and only when the answer is not already recorded. Collection stays off until
 * the answer is "granted" — the same posture the removed camera path was held to. Two levels, so the person can take the
 * smaller one: minutes only, or minutes plus which app and window (which never leaves this machine).
 */
export function LocalActivityConsent({ asked, upgrade = false }: { asked: boolean; upgrade?: boolean }) {
  const [done, setDone] = useState(asked && !upgrade);
  const [error, setError] = useState("");
  if (done) return null;
  const answer = async (body: { consent: "granted" | "denied"; detail?: "granted" | "denied" }) => {
    const response = await fetch("/api/settings/local-activity", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    });
    if (response.ok) { setDone(true); location.reload(); } else setError("没有保存成功，请重试。");
  };
  if (upgrade) return <aside className="consent-ask" role="region" aria-label="屏幕活动升级授权">
    <p><b>屏幕活动多了一档，要不要升级？</b></p>
    <p>你之前同意的是「只记每天的活跃分钟数」。新的一档会每分钟多读前台应用名和窗口标题，用来在今日显示「此刻状态」、在日历里画出「实际」做了什么。
      <b>标题只存在这台电脑上，不会发给任何模型，14 天后抹掉；银行、密码管理器、无痕窗口完全不记录</b>，随时可以暂停或在设置里清除。不升级的话，维持原来的只记分钟数，什么都不变。</p>
    <div>
      <button type="button" className="primary-button" onClick={() => void answer({ consent: "granted", detail: "granted" })}>升级（应用+窗口）</button>
      <button type="button" onClick={() => void answer({ consent: "granted", detail: "denied" })}>保持只记分钟数</button>
      <button type="button" onClick={() => setDone(true)}>稍后再说</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </aside>;
  return <aside className="consent-ask" role="region" aria-label="本机活动采集授权">
    <p><b>要不要让系统看一眼你在做什么？</b></p>
    <p>每分钟读取：前台应用名、窗口标题、距上次输入的时间。用来判断你是在专注、频繁切换、开会还是离开，并在日历里画出“实际”做了什么。
      <b>不记录按键，不截屏，不上传：应用名和窗口标题只存在这台电脑上，也不会发给任何模型</b>（模型最多看到“编程 20 分钟”这样的分类时长）。
      银行、密码管理器、无痕窗口默认完全不记录；标题 14 天后自动抹掉；随时可以暂停，也可以在设置里查看和清除。</p>
    <div>
      <button type="button" className="primary-button" onClick={() => void answer({ consent: "granted", detail: "granted" })}>开启（应用+窗口）</button>
      <button type="button" onClick={() => void answer({ consent: "granted" })}>只记活跃分钟数</button>
      <button type="button" onClick={() => void answer({ consent: "denied" })}>不开启</button>
      {/* Hides for this visit only — nothing is written, so the question comes back next time rather
          than being silently decided as "denied" on the person's behalf. */}
      <button type="button" onClick={() => setDone(true)}>稍后再说</button>
    </div>
    {error && <p role="alert">{error}</p>}
  </aside>;
}
