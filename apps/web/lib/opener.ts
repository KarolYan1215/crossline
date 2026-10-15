/**
 * The day's opener as data (stored beside its text in the message payload), so Today's conversation and the return page draw the same
 * card: a small day timeline in the lines' colours, the most urgent decision on its own, the number waiting as a mark. Pure; the text
 * stays in the card's question for the desktop and phone, and for messages written before this, which carry no payload.
 */
export type OpenerBlock = { start: string; end: string; title: string; step?: string; line?: string };
export type OpenerView = {
  /** `YYYY-MM-DD` in the person's zone, and how the card names it (「10 月 15 日 周四」). */
  day: string; label: string; timeZone: string;
  /** Fixed arrangements (calendar, file dates, events) and the blocks placed for work, in start order. */
  fixed: OpenerBlock[]; work: OpenerBlock[];
  /** Open work due within three days. */
  soon: Array<{ title: string; due: string; line?: string }>;
  /** This week's decisions: how many, and the most urgent one. */
  asks: { count: number; top?: { title: string; urgency: "now" | "soon" | "later"; line?: string } };
};

export const minutesOfClock = (clock: string) => { const [h, m] = clock.split(":").map(Number); return (h ?? 0) * 60 + (m ?? 0); };

export function dayLabel(day: string): string {
  return `${Number(day.slice(5, 7))} 月 ${Number(day.slice(8, 10))} 日 周${"日一二三四五六"[new Date(`${day}T12:00:00Z`).getUTCDay()]}`;
}

/** The hours the card's axis covers: at least 08:00–20:00, widened to whole hours around anything earlier or later. */
export function openerAxis(view: Pick<OpenerView, "fixed" | "work">): { from: number; to: number } {
  const blocks = [...view.fixed, ...view.work];
  const first = Math.min(8 * 60, ...blocks.map((block) => minutesOfClock(block.start)));
  const last = Math.max(20 * 60, ...blocks.map((block) => Math.max(minutesOfClock(block.end), minutesOfClock(block.start) + 1)));
  return { from: Math.max(0, Math.floor(first / 60) * 60), to: Math.min(24 * 60, Math.ceil(last / 60) * 60) };
}

/** Where a block sits on the axis, in percent of its width (clamped, at least a sliver so a short block still shows). */
export function blockSpan(block: OpenerBlock, axis: { from: number; to: number }): { left: number; width: number } {
  const span = axis.to - axis.from;
  const start = Math.min(Math.max(minutesOfClock(block.start), axis.from), axis.to);
  const end = Math.min(Math.max(minutesOfClock(block.end), start), axis.to);
  const left = ((start - axis.from) / span) * 100;
  return { left, width: Math.max(0.8, Math.min(100 - left, ((end - start) / span) * 100)) };
}

/** Minutes of work placed in the day. */
export const workMinutes = (view: Pick<OpenerView, "work">) =>
  view.work.reduce((sum, block) => sum + Math.max(0, minutesOfClock(block.end) - minutesOfClock(block.start)), 0);

export function hoursText(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 6) / 10;
  return `${Number.isInteger(hours) ? hours : hours.toFixed(1)} 小时`;
}

/** Reads a stored payload back, or nothing when it is not one (an older message, or a shape this version does not know). */
export function readOpener(value: unknown): OpenerView | undefined {
  const view = value as Partial<OpenerView> | undefined;
  return view && typeof view.day === "string" && Array.isArray(view.fixed) && Array.isArray(view.work) && Array.isArray(view.soon)
    && typeof view.asks?.count === "number" ? view as OpenerView : undefined;
}
