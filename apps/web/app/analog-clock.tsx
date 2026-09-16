"use client";
import { useEffect, useState } from "react";

/**
 * The day head's clock.
 *
 * It used to be a bare circle with one green dot pinned at dead centre — no hands, no marks, nothing
 * that moved — while carrying `aria-label="此刻 …"`. It read as a broken widget because it was not a
 * clock at all, only the outline of one.
 *
 * Hands are placed from `nowIso`, the same instant every other number on this page comes from, read in
 * `timeZone` rather than the browser's own zone so the dial and the 「周三 11:16」 label cannot disagree.
 * When the clock is pinned (`CROSSLINE_FIXED_NOW`, which the visual-regression run sets) nothing ticks
 * and there is no second hand, so the snapshot stays reproducible.
 */
export function AnalogClock({ nowIso, timeZone, fixed }: { nowIso: string; timeZone: string; fixed: boolean }) {
  const [now, setNow] = useState(() => new Date(nowIso));
  useEffect(() => {
    if (fixed) return;
    // Re-read the wall clock rather than counting up from the server's instant: a laptop that slept
    // would otherwise show however long it was asleep as elapsed time.
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, [fixed]);

  const { hours, minutes, seconds } = readClock(now, timeZone);
  const hourAngle = ((hours % 12) + minutes / 60) * 30;
  const minuteAngle = (minutes + seconds / 60) * 6;
  const secondAngle = seconds * 6;
  const label = `此刻 ${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;

  return <svg className="analog-clock" viewBox="0 0 200 200" role="img" aria-label={label}>
    <circle className="ac-ring" cx="100" cy="100" r="96" />
    <g className="ac-ticks">{Array.from({ length: 60 }, (_, index) => {
      const major = index % 5 === 0;
      return <line key={index} className={major ? "ac-tick major" : "ac-tick"}
        x1="100" x2="100" y1="8" y2={major ? 19 : 13} transform={`rotate(${index * 6} 100 100)`} />;
    })}</g>
    <g className="ac-nums">{([["12", 100, 34], ["03", 166, 100], ["06", 100, 166], ["09", 34, 100]] as const)
      .map(([text, x, y]) => <text key={text} x={x} y={y} textAnchor="middle" dominantBaseline="central">{text}</text>)}</g>
    <line className="ac-hand hour" x1="100" y1="100" x2="100" y2="44" transform={`rotate(${hourAngle} 100 100)`} />
    <line className="ac-hand minute" x1="100" y1="100" x2="100" y2="22" transform={`rotate(${minuteAngle} 100 100)`} />
    {!fixed && <g transform={`rotate(${secondAngle} 100 100)`}>
      <line className="ac-hand second" x1="100" y1="113" x2="100" y2="21" />
      <circle className="ac-second-dot" cx="100" cy="18" r="2.8" />
    </g>}
    <circle className="ac-pin" cx="100" cy="100" r="5" />
    <circle className="ac-pin-core" cx="100" cy="100" r="1.8" />
  </svg>;
}

/**
 * The hour, minute and second that `instant` shows in `timeZone`.
 *
 * `Date` only ever exposes UTC or the host's zone, and this board's whole notion of "today" is one
 * declared zone — so the parts are taken from the formatter that already knows it instead of from
 * `getHours()`, which would quietly show the dial in whatever zone the browser happens to be in.
 */
function readClock(instant: Date, timeZone: string): { hours: number; minutes: number; seconds: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone
  }).formatToParts(instant);
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  // `hourCycle: h23` still renders midnight as 24 in some engines; 24 and 0 are the same angle anyway.
  return { hours: value("hour") % 24, minutes: value("minute"), seconds: value("second") };
}
