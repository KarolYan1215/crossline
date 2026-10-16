import type { Reminder } from "../lib/reminders";
import "./reminder-strip.css";

/** Today's 「提醒」: what other pages flag for the person, one line each, each a link to where it is dealt with (`lib/reminders.ts`). */
export function ReminderStrip({ reminders }: { reminders: Reminder[] }) {
  if (!reminders.length) return null;
  return <section className="reminders" aria-labelledby="reminders-title">
    <h2 id="reminders-title" className="section-label">提醒</h2>
    <ul>{reminders.map((item) => <li key={item.id} {...(item.line ? { "data-line": item.line } : {})}>
      <a href={item.href} title={item.text}><span>{item.text}</span><span aria-hidden="true">→</span></a></li>)}</ul>
  </section>;
}
