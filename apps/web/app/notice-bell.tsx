"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { pollWhileVisible } from "./ui/visible-poll";
import type { NoticesBody, NoticeView } from "./notice-kinds";
import { useLocale, useT } from "./locale-context";
import { intlLocale, tFor, type Locale } from "../lib/i18n";
import "./notice-bell.css";

/** The last reminder that popped up, so one reminder pops once, not again on every page while it is unread. */
const TOASTED_KEY = "crossline.notice.toasted";
const TOAST_MS = 8_000;
/** Asks the 小帮手 to open its panel (a reminder whose buttons act is handled there). */
export const OPEN_HELPER_EVENT = "crossline:open-helper";

const readKey = () => { try { return localStorage.getItem(TOASTED_KEY) ?? ""; } catch { return ""; } };
const writeKey = (value: string) => { try { localStorage.setItem(TOASTED_KEY, value); } catch { /* private browsing */ } };

/** 「10:32」 today, 「昨天 10:32」, else 「10/25 10:32」. Exported for its test. */
export function noticeTime(at: string, now = new Date(), locale?: Locale): string {
  const when = new Date(at);
  const clock = when.toLocaleTimeString(intlLocale(locale), { hour: "2-digit", minute: "2-digit", hour12: false });
  const day = (date: Date) => date.toLocaleDateString("en-CA");
  if (day(when) === day(now)) return clock;
  if (day(when) === day(new Date(now.getTime() - 86_400_000))) return tFor(locale)("昨天 {{clock}}", { clock });
  return `${when.getMonth() + 1}/${when.getDate()} ${clock}`;
}

/** The newest unread reminder that has not popped yet, if any. Exported for its test. */
export function toastCandidate(body: NoticesBody, toasted: string): NoticeView | undefined {
  const newest = body.items[0];
  return newest && newest.at > body.readAt && newest.id !== toasted ? newest : undefined;
}

function NoticeItem({ item, onDone }: { item: NoticeView; onDone: () => void }) {
  const t = useT();
  return <>
    <p>{item.text}</p>
    {(item.links.length > 0 || item.actionable) && <div className="notice-links">
      {item.links.map((link) => <a key={link.href + link.label} href={link.href} onClick={onDone}>{link.label}</a>)}
      {item.actionable && <button type="button" onClick={() => { window.dispatchEvent(new Event(OPEN_HELPER_EVENT)); onDone(); }}>{t("在小帮手里处理")}</button>}
    </div>}
  </>;
}

/**
 * The bell at the top right (2026-10-27, the owner: 「不需要用户输入的提醒放到右上角一个提醒按钮，有新来的提醒弹窗，有未读的红点」): every
 * message the system says to the person that asks nothing — a mail to check in the bank's app, an errand's departure reminder, work that
 * finished, the day's tidy-up. A red dot while anything is unread; a new one pops up under the bell once for eight seconds; opening the
 * bell marks everything read. What asks for an answer stays with the 小帮手 and 待决事项.
 */
export function NoticeBell() {
  const t = useT();
  const locale = useLocale();
  const [body, setBody] = useState<NoticesBody | null>(null);
  const [open, setOpen] = useState(false);
  const [toast, setToast] = useState<NoticeView | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => pollWhileVisible(async () => {
    const response = await fetch("/api/notices", { cache: "no-store" }).catch(() => undefined);
    const next = await response?.json().catch(() => undefined) as (NoticesBody & { ok?: boolean }) | undefined;
    if (!next?.ok) return;
    setBody(next);
    const fresh = toastCandidate(next, readKey());
    if (!fresh) return;
    writeKey(fresh.id);
    setToast(fresh);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), TOAST_MS);
  }, 60_000), []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", close); };
  }, [open]);
  const unread = body?.unread ?? 0;
  const toggle = () => {
    setToast(null);
    if (open) { setOpen(false); return; }
    setOpen(true);
    const newest = body?.items[0]?.at;
    if (!newest || !unread) return;
    setBody((current) => current ? { ...current, unread: 0, readAt: newest } : current);
    void fetch("/api/notices", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ readAt: newest }) }).catch(() => {});
  };
  return <div className="notice-bell" ref={root}>
    <button type="button" className="notice-bell-button" aria-expanded={open} aria-haspopup="dialog"
      aria-label={unread ? t("提醒，{{count}} 条未读", { count: unread }) : t("提醒")} title={t("提醒")} onClick={toggle} {...(unread ? { "data-unread": "" } : {})}>
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3a6 6 0 0 0-6 6v4l-2 3h16l-2-3V9a6 6 0 0 0-6-6Zm-2 15a2 2 0 0 0 4 0"
        fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" /></svg>
      {unread > 0 && <span className="notice-dot">{unread > 9 ? "9+" : unread}</span>}
    </button>
    {open && <div className="notice-panel" role="dialog" aria-label={t("提醒")}>
      <h2>{t("提醒")}</h2>
      {!body?.items.length ? <p className="muted">{t("近 7 天没有提醒。")}</p>
        : <ol>{body.items.map((item) => <li key={item.id} {...(item.at > (body.readAt ?? "") && unread ? { "data-unread": "" } : {})}>
          <time dateTime={item.at}>{noticeTime(item.at, new Date(), locale)}</time>
          <NoticeItem item={item} onDone={() => setOpen(false)} />
        </li>)}</ol>}
    </div>}
    {/* On the page's top layer: inside the header it sat under the banners that follow it. */}
    {toast && !open && createPortal(<div className="notice-toast" role="status" aria-live="polite">
      <button type="button" className="notice-toast-close" aria-label={t("关闭")} onClick={() => setToast(null)}>×</button>
      <button type="button" className="notice-toast-body" onClick={toggle}>{toast.text}</button>
    </div>, document.body)}
  </div>;
}
