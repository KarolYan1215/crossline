/**
 * 「10/13 22:46」: a stored instant (UTC ISO) as the person's clock reads it — in `timeZone` when given, else the device's own. Pages
 * used to print `iso.slice(5, 16)`, which is UTC: an evening in Chicago showed as the next morning.
 */
export function localStamp(iso: string, timeZone?: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { ...(timeZone ? { timeZone } : {}), month: "numeric", day: "numeric",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((part) => [part.type, part.value]));
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}
