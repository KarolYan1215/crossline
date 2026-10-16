import { entryHistogram } from "../asks/model";
import { tFor, type Locale } from "../../lib/i18n";
import { shortDate } from "../task/format";

/**
 * What waits on 待确认 besides this week's questions, drawn rather than tiled: when the decisions that can wait come into the week (one
 * bar per day over four weeks, hovering gives the day and count), and one line of counts for what is decided further down the page or on
 * another page, each a link. Nothing is drawn for a count of zero.
 */
export function PendingSummary({ later, today, here, elsewhere, locale }: {
  /** The day each deferred decision comes into the week. */
  later: string[]; today: string;
  here: Array<{ label: string; count: number; href: string }>;
  elsewhere: Array<{ label: string; count: number; href: string }>;
  /** The page's language; the labels above come translated. */
  locale?: Locale | undefined;
}) {
  const t = tFor(locale);
  const shortDay = (day: string) => shortDate(locale, day);
  const bars = entryHistogram(later, today);
  const top = Math.max(1, ...bars.map((bar) => bar.count));
  const first = [...later].sort()[0];
  const links = (items: typeof here) => items.filter((item) => item.count > 0).map((item, index) =>
    <a key={item.label} href={item.href}>{index > 0 && <span aria-hidden="true"> · </span>}{item.label} <b className="mono">{item.count}</b></a>);
  const hereLinks = links(here), elsewhereLinks = links(elsewhere);
  if (!later.length && !hereLinks.length && !elsewhereLinks.length) return null;
  return <section className="ap-summary" aria-label={t("待确认汇总")}>
    {hereLinks.length > 0 && <p className="ap-summary-line"><span>{t("本页还有")}</span>{hereLinks}</p>}
    {elsewhereLinks.length > 0 && <p className="ap-summary-line"><span>{t("在别处决定")}</span>{elsewhereLinks}</p>}
    {later.length > 0 && <a className="ap-later" href="#later" aria-label={t("以后再定 {{count}} 项，最早 {{day}} 列入本周", { count: later.length, day: first ? shortDay(first) : "" })}>
      <span className="ap-later-label">{t("以后再定")} <b className="mono">{later.length}</b>{first && <small> · {t("最早 {{day}}", { day: shortDay(first) })}</small>}</span>
      <svg className="ap-later-bars" viewBox={`0 0 ${bars.length * 6} 24`} preserveAspectRatio="none" aria-hidden="true">
        {bars.map((bar, index) => <g key={bar.day}>
          <rect x={index * 6} y="0" width="5" height="24" className="ap-later-slot"><title>{t("{{day}} · {{count}} 项", { day: shortDay(bar.day), count: bar.count })}</title></rect>
          {bar.count > 0 && <rect x={index * 6} y={24 - (bar.count / top) * 22 - 2} width="5" height={(bar.count / top) * 22 + 2} className="ap-later-bar">
            <title>{t("{{day}} 列入本周 · {{count}} 项", { day: shortDay(bar.day), count: bar.count })}</title></rect>}
          {index % 7 === 0 && <rect x={index * 6} y="22" width="1" height="2" className="ap-later-tick" />}
        </g>)}
      </svg>
      <span className="ap-later-axis" aria-hidden="true"><small>{shortDay(bars[0]!.day)}</small><small>{shortDay(bars.at(-1)!.day)}</small></span>
    </a>}
  </section>;
}
