import { entryHistogram, shortDay } from "../asks/model";

/**
 * What waits on 待确认 besides this week's questions, drawn rather than tiled: when the decisions that can wait come into the week (one
 * bar per day over four weeks, hovering gives the day and count), and one line of counts for what is decided further down the page or on
 * another page, each a link. Nothing is drawn for a count of zero.
 */
export function PendingSummary({ later, today, here, elsewhere }: {
  /** The day each deferred decision comes into the week. */
  later: string[]; today: string;
  here: Array<{ label: string; count: number; href: string }>;
  elsewhere: Array<{ label: string; count: number; href: string }>;
}) {
  const bars = entryHistogram(later, today);
  const top = Math.max(1, ...bars.map((bar) => bar.count));
  const first = [...later].sort()[0];
  const links = (items: typeof here) => items.filter((item) => item.count > 0).map((item, index) =>
    <a key={item.label} href={item.href}>{index > 0 && <span aria-hidden="true"> · </span>}{item.label} <b className="mono">{item.count}</b></a>);
  const hereLinks = links(here), elsewhereLinks = links(elsewhere);
  if (!later.length && !hereLinks.length && !elsewhereLinks.length) return null;
  return <section className="ap-summary" aria-label="待确认汇总">
    {hereLinks.length > 0 && <p className="ap-summary-line"><span>本页还有</span>{hereLinks}</p>}
    {elsewhereLinks.length > 0 && <p className="ap-summary-line"><span>在别处决定</span>{elsewhereLinks}</p>}
    {later.length > 0 && <a className="ap-later" href="#later" aria-label={`以后再定 ${later.length} 项，最早 ${first ? shortDay(first) : ""} 列入本周`}>
      <span className="ap-later-label">以后再定 <b className="mono">{later.length}</b>{first && <small> · 最早 {shortDay(first)}</small>}</span>
      <svg className="ap-later-bars" viewBox={`0 0 ${bars.length * 6} 24`} preserveAspectRatio="none" aria-hidden="true">
        {bars.map((bar, index) => <g key={bar.day}>
          <rect x={index * 6} y="0" width="5" height="24" className="ap-later-slot"><title>{`${shortDay(bar.day)} · ${bar.count} 项`}</title></rect>
          {bar.count > 0 && <rect x={index * 6} y={24 - (bar.count / top) * 22 - 2} width="5" height={(bar.count / top) * 22 + 2} className="ap-later-bar">
            <title>{`${shortDay(bar.day)} 列入本周 · ${bar.count} 项`}</title></rect>}
          {index % 7 === 0 && <rect x={index * 6} y="22" width="1" height="2" className="ap-later-tick" />}
        </g>)}
      </svg>
      <span className="ap-later-axis" aria-hidden="true"><small>{shortDay(bars[0]!.day)}</small><small>{shortDay(bars.at(-1)!.day)}</small></span>
    </a>}
  </section>;
}
