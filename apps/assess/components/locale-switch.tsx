"use client";
import { useState } from "react";
import { LOCALE_COOKIE, LOCALE_SWITCH_EVENT, type Locale } from "../lib/i18n";
import { useLocale } from "./locale-context";

const YEAR = 365 * 24 * 60 * 60;

/**
 * 「中文 / EN」 at the top right of every page. The choice goes to `/api/locale` (which sets the cookie); if that call fails the cookie
 * is written here instead, so the switch never just does nothing. Before the reload the page is told (`LOCALE_SWITCH_EVENT`), so a test
 * in progress writes its answers to sessionStorage first and resumes on the same statement in the other language.
 */
export function LocaleSwitch() {
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const next: Locale = locale === "en" ? "zh" : "en";
  const change = async () => {
    setBusy(true);
    window.dispatchEvent(new Event(LOCALE_SWITCH_EVENT));
    let saved = false;
    try {
      const response = await fetch("/api/locale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: next }) });
      saved = response.ok;
    } catch { saved = false; }
    if (!saved) document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=${YEAR}; samesite=lax`;
    window.location.reload();
  };
  // Each label is written in the language it switches to, whatever the page's language.
  /* i18n-ignore-start */
  return <button type="button" className="as-lang" disabled={busy} onClick={() => { void change(); }}
    lang={next === "en" ? "en" : "zh-CN"} aria-label={next === "en" ? "Switch to English" : "切换到中文"}>
    {next === "en" ? "EN" : "中文"}
  </button>;
  /* i18n-ignore-end */
}
