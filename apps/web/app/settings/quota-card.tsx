import type { CostSignal, CostWindow } from "@crossline/core";

const windowName = (window: CostWindow) => (window.windowDurationMins ?? 0) >= 24 * 60 ? "每周" : `${Math.round((window.windowDurationMins ?? 300) / 60)} 小时`;

/** Wall-clock reset in the person's zone; the runtime reports Unix seconds. */
function resetText(resetsAt: number | null, now: Date, timeZone: string): string {
  if (!resetsAt) return "";
  const at = new Date(resetsAt * 1000);
  const hours = (at.getTime() - now.getTime()) / 3_600_000;
  const when = at.toLocaleString("zh-CN", { timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  return hours <= 0 ? "已重置" : `${when} 重置（约 ${hours < 1 ? `${Math.max(1, Math.round(hours * 60))} 分钟` : `${Math.round(hours)} 小时`}后）`;
}

/** The reason in words; settings never shows a code, an env name or the runtime's English (copy-style). */
function unavailableText(reason: string): string {
  if (/auth|login|apikey|api key/i.test(reason)) return "还没有登录模型账号，或当前登录方式（API key）没有额度窗口";
  if (/SUPERVISOR|CAPABILITY|ECONNREFUSED|fetch failed|timeout|abort|worker|unreachable/i.test(reason)) return "后台服务没有连上";
  return "暂时读不到";
}

/**
 * How much of the model quota is left and when it comes back, with the points at which background work changes: under 15% left the
 * background keeps only the person's own captures and plans moving, at 0% it pauses (`backgroundSpend`). An API-key connection shows
 * this month's spend against its cap instead.
 */
export function QuotaCard({ signal, now, timeZone }: { signal: CostSignal; now: Date; timeZone: string }) {
  if (!signal.available) return <p className="muted">读不到模型额度：{unavailableText(signal.reason)}。后台自动工作会暂停，本人发起的操作照常运行。</p>;
  const windows = [signal.short, signal.long].filter((window): window is CostWindow => Boolean(window));
  return <div className="st-quota">
    {signal.money
      ? <div className="ui-stat"><b>${signal.money.spent.toFixed(2)} / ${signal.money.cap.toFixed(0)}</b><span>本月 API 花费 / 上限</span></div>
      : windows.map((window) => {
        const left = Math.max(0, Math.round(100 - window.usedPercent));
        return <div key={windowName(window)} className="st-quota-row" data-low={left <= 15 || undefined}>
          <span>{windowName(window)}窗口</span>
          <meter min={0} max={100} low={15} high={30} optimum={100} value={left} aria-label={`${windowName(window)}窗口剩余 ${left}%`} />
          <b>剩 {left}%</b><small className="muted">{resetText(window.resetsAt, now, timeZone)}</small>
        </div>;
      })}
    <small className="muted">剩余低于 15% 时，后台只做收集分析、倒推和步骤规划；用尽时后台暂停，本人发起的操作照常运行。</small>
  </div>;
}
