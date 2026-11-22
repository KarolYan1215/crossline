"use client";
import { useEffect, useState } from "react";
import { SUBSCRIPTION_GUIDES, type CalendarSubscription } from "@crossline/core";
import { useLocale, useT } from "../locale-context";
import type { Translate } from "../../lib/i18n";
import { subscriptionGuide } from "../../lib/setup-guides";
import "./calendar-setup-step.css";

const GUIDE = subscriptionGuide(SUBSCRIPTION_GUIDES);

const ago = (at: string | undefined, now: number, t: Translate) => {
  if (!at) return "";
  const minutes = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  return minutes < 1 ? t("刚刚读过") : minutes < 60 ? t("{{count}} 分钟前读过", { count: minutes }) : minutes < 1440 ? t("{{count}} 小时前读过", { count: Math.round(minutes / 60) })
    : t("{{count}} 天前读过", { count: Math.round(minutes / 1440) });
};

/**
 * A calendar by its subscription link (docs/onboarding-v3.md 「日历接入」, decided 2026-10-14): the private iCal address Apple, Google
 * and Outlook all export. Read-only, no sign-in. The link is a key to the calendar, so it is kept only on this computer, never in a
 * backup; the card shows where it points and how the last read went.
 */
export function CalendarSubscriptions({ onChanged }: { onChanged?: () => void }) {
  const t = useT();
  const en = useLocale() === "en";
  const [items, setItems] = useState<CalendarSubscription[] | undefined>();
  const [link, setLink] = useState("");
  const [label, setLabel] = useState("");
  const [guide, setGuide] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [now, setNow] = useState(0);

  const load = async () => {
    const response = await fetch("/api/calendar/subscriptions", { cache: "no-store" }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { subscriptions?: CalendarSubscription[] } | undefined;
    setItems(body?.subscriptions ?? []);
    setNow(Date.now());
  };
  useEffect(() => { void load(); }, []);

  const add = async (pasted?: string) => {
    setBusy(true); setMessage("");
    const response = await fetch("/api/calendar/subscriptions", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ link: pasted ?? link, label }) }).catch(() => undefined);
    const body = await response?.json().catch(() => undefined) as { state?: string; events?: number; message?: string } | undefined;
    if (body?.state === "added") {
      setLink(""); setLabel("");
      // All-day events (holidays, birthdays) are never read in: say so when that is why nothing came, or a holiday calendar reads as broken.
      setMessage(body.events ? t("已接入，读到未来九周的 {{count}} 个日程（全天日程不读入）。", { count: body.events })
        : t("已接入。未来九周里没有读到有具体时间的日程：全天日程（节假日、生日）和标为「空闲」的不读入。"));
      onChanged?.();
    } else setMessage(body?.message ?? t("没能接入这个日历，稍后再试。"));
    await load();
    setBusy(false);
  };
  const remove = async (id: string) => {
    setBusy(true);
    const response = await fetch(`/api/calendar/subscriptions?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    setMessage(response?.ok ? t("已移除，这本日历的日程已从计划里拿掉。") : t("没能移除，稍后再试。"));
    await load();
    onChanged?.();
    setBusy(false);
  };
  // One click after copying the link on the calendar's page: read the clipboard and connect. A browser that will not give the clipboard
  // (permission refused, or not a secure page) leaves the box below to paste into by hand.
  const pasteAndAdd = async () => {
    const text = (await navigator.clipboard?.readText().catch(() => "") ?? "").trim();
    if (/^(https|webcal):\/\/\S+$/i.test(text)) { setLink(text); await add(text); }
    else setMessage(text ? t("剪贴板里不是日历链接：请在日历的设置页拷贝订阅链接，再点一次。") : t("浏览器没有允许读取剪贴板，请把链接粘贴到下面的框里。"));
  };

  const chosen = GUIDE.providers.find((item) => item.id === guide);

  return <section className="st-card calendar-subscriptions" aria-label={t("订阅日历")}>
    <header><h3>{t("订阅日历")}</h3><small>{t("先选所用的日历服务，照下面的步骤拷贝订阅链接，回来点「粘贴并接入」。只读，不用登录。")}</small></header>
    {items?.map((item) => <div className="st-row" key={item.id}>
      <span className="st-row-label">{item.label}
        <small>{item.host}{item.lastError ? ` · ${item.lastError}` : item.lastReadAt ? ` · ${ago(item.lastReadAt, now, t)}${en ? ", " : "，"}${t("{{count}} 个日程", { count: item.lastEvents ?? 0 })}` : ""}</small>
      </span>
      <button type="button" className="ob-btn ob-quiet secondary-button" disabled={busy} onClick={() => void remove(item.id)}>{t("移除")}</button>
    </div>)}
    {/* The provider first, then its steps in full (2026-11-22): they used to sit folded under a tutorial bar, and the button left the
        page before the person had read what to copy there. */}
    <div className="calendar-subscriptions-providers" role="radiogroup" aria-label={t("从哪个日历接入")}>
      {SUBSCRIPTION_GUIDES.map((item) => <button key={item.app} type="button" role="radio" aria-checked={guide === item.app}
        className="ob-btn secondary-button" data-picked={guide === item.app || undefined} onClick={() => setGuide(item.app)}>{t(item.app)}</button>)}
    </div>
    <b>{t(GUIDE.title)}</b>
    {chosen ? <div className="calendar-subscriptions-steps" role="group" aria-label={t("{{label}}的步骤", { label: t(chosen.label) })}>
      <ol>{chosen.steps.map((step) => <li key={step}>{t(step)}</li>)}</ol>
      {chosen.links?.[0] && <a className="ob-btn secondary-button" href={chosen.links[0].url} target="_blank" rel="noopener noreferrer">
        {t("打开{{app}}的设置页", { app: t(chosen.label) })} ↗</a>}
      {chosen.note && <p className="calendar-subscriptions-note">{t(chosen.note)}</p>}
    </div> : <p className="muted">{t("选一个日历服务，这里列出它的步骤。")}</p>}
    <button type="button" className="ob-btn primary-button" disabled={busy} onClick={() => void pasteAndAdd()}>{busy ? t("读取中…") : t("粘贴并接入")}</button>
    <form className="calendar-subscriptions-form" onSubmit={(event) => { event.preventDefault(); if (link.trim()) void add(); }}>
      <input type="url" inputMode="url" value={link} onChange={(event) => setLink(event.target.value)} placeholder={t("或手动粘贴：webcal://… 或 https://…ics")} aria-label={t("日历订阅链接")} disabled={busy} />
      <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t("名称（可选，如「工作日程」）")} aria-label={t("日历名称")} maxLength={40} disabled={busy} />
      <button type="submit" className="ob-btn secondary-button" disabled={busy || !link.trim()}>{t("接入")}</button>
    </form>
    {message && <p role="status" className="muted">{message}</p>}
    <small className="muted">{t("链接相当于这本日历的钥匙：加密保存，只用来读取，不进备份。泄露了就在日历里重置，再在这里换上新链接。")}</small>
    {GUIDE.problems && <details className="calendar-subscriptions-problems"><summary>{t("常见出错")}</summary>
      <dl>{GUIDE.problems.map((problem) => <div key={problem.symptom}><dt>{t(problem.symptom)}</dt><dd>{t(problem.fix)}</dd></div>)}</dl>
    </details>}
  </section>;
}
