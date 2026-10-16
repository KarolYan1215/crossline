"use client";
import { useEffect, useState } from "react";
import { SUBSCRIPTION_GUIDES, type CalendarSubscription } from "@crossline/core";
import { useLocale, useT } from "../locale-context";
import type { Translate } from "../../lib/i18n";

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
      setMessage(t("已接入，读到未来九周的 {{count}} 个日程。", { count: body.events ?? 0 }));
      onChanged?.();
    } else setMessage(body?.message ?? t("没能接入这个日历，稍后再试。"));
    await load();
    setBusy(false);
  };
  const remove = async (id: string) => {
    setBusy(true);
    await fetch(`/api/calendar/subscriptions?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => undefined);
    await load();
    onChanged?.();
    setBusy(false);
  };
  const steps = SUBSCRIPTION_GUIDES.find((item) => item.app === guide)?.steps ?? [];
  // One click after copying the link on the calendar's page: read the clipboard and connect. A browser that will not give the clipboard
  // (permission refused, or not a secure page) leaves the box below to paste into by hand.
  const pasteAndAdd = async () => {
    const text = (await navigator.clipboard?.readText().catch(() => "") ?? "").trim();
    if (/^(https|webcal):\/\/\S+$/i.test(text)) { setLink(text); await add(text); }
    else setMessage(text ? t("剪贴板里不是日历链接：请在日历的设置页拷贝订阅链接，再点一次。") : t("浏览器没有允许读取剪贴板，请把链接粘贴到下面的框里。"));
  };

  return <section className="st-card calendar-subscriptions" aria-label={t("订阅日历")}>
    <header><h3>{t("订阅日历")}</h3><small>{t("点你用的日历，在打开的页面拷贝订阅链接，回来点「粘贴并接入」。只读，不用登录。")}</small></header>
    {items?.map((item) => <div className="st-row" key={item.id}>
      <span className="st-row-label">{item.label}
        <small>{item.host}{item.lastError ? ` · ${item.lastError}` : item.lastReadAt ? ` · ${ago(item.lastReadAt, now, t)}${en ? ", " : "，"}${t("{{count}} 个日程", { count: item.lastEvents ?? 0 })}` : ""}</small>
      </span>
      <button type="button" className="ob-btn ob-quiet secondary-button" disabled={busy} onClick={() => void remove(item.id)}>{t("移除")}</button>
    </div>)}
    <div className="calendar-subscriptions-providers" role="group" aria-label={t("从哪个日历接入")}>
      {SUBSCRIPTION_GUIDES.map((item) => <a key={item.app} href={item.url} target="_blank" rel="noreferrer" className="ob-btn secondary-button"
        aria-current={guide === item.app || undefined} onClick={() => setGuide(item.app)}>{t(item.app)} ↗</a>)}
    </div>
    {guide && <ol className="calendar-subscriptions-guide">{steps.map((step) => <li key={step}>{t(step)}</li>)}</ol>}
    <button type="button" className="ob-btn primary-button" disabled={busy} onClick={() => void pasteAndAdd()}>{busy ? t("读取中…") : t("粘贴并接入")}</button>
    <form className="calendar-subscriptions-form" onSubmit={(event) => { event.preventDefault(); if (link.trim()) void add(); }}>
      <input type="url" inputMode="url" value={link} onChange={(event) => setLink(event.target.value)} placeholder={t("或手动粘贴：webcal://… 或 https://…ics")} aria-label={t("日历订阅链接")} disabled={busy} />
      <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder={t("名称（可选，如「课表」）")} aria-label={t("日历名称")} maxLength={40} disabled={busy} />
      <button type="submit" className="ob-btn secondary-button" disabled={busy || !link.trim()}>{t("接入")}</button>
    </form>
    {message && <p role="status" className="muted">{message}</p>}
    <small className="muted">{t("链接相当于这本日历的钥匙：加密保存，只用来读取，不进备份。")}</small>
  </section>;
}
