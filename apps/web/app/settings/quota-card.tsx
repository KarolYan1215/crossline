import type { CostSignal, CostWindow } from "@crossline/core";
import { intlLocale, tFor, type Locale, type Translate } from "../../lib/i18n";

/** 「5 小时窗口」 / 「每周窗口」. */
const windowName = (window: CostWindow, t: Translate) => (window.windowDurationMins ?? 0) >= 24 * 60 ? t("每周窗口")
  : t("{{hours}} 小时窗口", { hours: Math.round((window.windowDurationMins ?? 300) / 60) });

/** Wall-clock reset in the person's zone; the runtime reports Unix seconds. */
function resetText(resetsAt: number | null, now: Date, timeZone: string, locale: Locale | undefined): string {
  const t = tFor(locale);
  if (!resetsAt) return "";
  const at = new Date(resetsAt * 1000);
  const hours = (at.getTime() - now.getTime()) / 3_600_000;
  const when = at.toLocaleString(intlLocale(locale), { timeZone, month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
  if (hours <= 0) return t("已重置");
  return hours < 1 ? t("{{when}} 重置（约 {{minutes}} 分钟后）", { when, minutes: Math.max(1, Math.round(hours * 60)) })
    : t("{{when}} 重置（约 {{hours}} 小时后）", { when, hours: Math.round(hours) });
}

/** The reason in words; settings never shows a code, an env name or the runtime's English (copy-style). */
function unavailableText(reason: string, t: Translate): string {
  if (/PROVIDER_BUDGET/.test(reason)) return t("当前的其他模型按用量计费，应用不知道它的价格，无法替你设上限");
  if (/auth|login|apikey|api key/i.test(reason)) return t("还没有登录模型账号，或当前登录方式（API key）没有额度窗口");
  if (/SUPERVISOR|CAPABILITY|ECONNREFUSED|fetch failed|timeout|abort|worker|unreachable/i.test(reason)) return t("后台服务没有连上");
  return t("暂时读不到");
}

/**
 * How much of the model quota is left and when it comes back, with the points at which background work changes: under 15% left the
 * background keeps only the person's own captures and plans moving, at 0% it pauses (`backgroundSpend`). An API-key connection shows
 * this month's spend against its cap instead.
 */
export function QuotaCard({ signal, now, timeZone, locale }: { signal: CostSignal; now: Date; timeZone: string; locale?: Locale }) {
  const t = tFor(locale);
  if (!signal.available) return <p className="muted">{t("读不到模型额度：{{reason}}。后台自动工作会暂停，本人发起的操作照常运行。", { reason: unavailableText(signal.reason, t) })}</p>;
  const windows = [signal.short, signal.long].filter((window): window is CostWindow => Boolean(window));
  return <div className="st-quota">
    {signal.money
      ? <div className="ui-stat"><b>${signal.money.spent.toFixed(2)} / ${signal.money.cap.toFixed(0)}</b><span>{t("本月 API 花费 / 上限")}</span></div>
      : windows.map((window) => {
        const left = Math.max(0, Math.round(100 - window.usedPercent));
        const name = windowName(window, t);
        return <div key={name} className="st-quota-row" data-low={left <= 15 || undefined}>
          <span>{name}</span>
          <meter min={0} max={100} low={15} high={30} optimum={100} value={left} aria-label={t("{{window}}剩余 {{left}}%", { window: name, left })} />
          <b>{t("剩 {{left}}%", { left })}</b><small className="muted">{resetText(window.resetsAt, now, timeZone, locale)}</small>
        </div>;
      })}
    <small className="muted">{t("剩余低于 15% 时，后台只做收集分析、倒推和步骤规划；用尽时后台暂停，本人发起的操作照常运行。")}</small>
  </div>;
}
