"use client";
import { useEffect, useState } from "react";
import type { Locale } from "../lib/i18n";
import { useLocale } from "./locale-context";

/**
 * 「中 / EN」: one press switches the whole site (docs/i18n.md). The choice is kept in the browser and, when signed in, on the account,
 * so another device opens in it too: on a device whose cookie says nothing yet, `sync` adopts the account's choice once.
 */
export function LocaleSwitch({ sync = false }: { sync?: boolean }) {
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const change = async (next: Locale) => {
    setBusy(true);
    try {
      const response = await fetch("/api/locale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: next }) });
      // A whole reload, not a refresh: every client component and cached fragment comes back in the new language at once.
      if (response.ok) location.reload();
    } finally { setBusy(false); }
  };
  useEffect(() => {
    if (!sync) return;
    void fetch("/api/locale", { cache: "no-store" }).then((response) => response.json())
      .then((body: { cookie?: Locale | null; account?: Locale | null }) => {
        // Only a device with no choice of its own adopts the account's; a choice made here wins on this device.
        if (!body.cookie && body.account && body.account !== locale) void change(body.account);
      }).catch(() => undefined);
  }, [sync]); // eslint-disable-line react-hooks/exhaustive-deps
  const next: Locale = locale === "en" ? "zh" : "en";
  // Each label is written in the language it switches to, whatever the page's language.
  /* i18n-ignore-start */
  return <button type="button" className="locale-switch" disabled={busy} onClick={() => { void change(next); }}
    lang={next === "en" ? "en" : "zh-CN"} aria-label={next === "en" ? "Switch to English" : "切换到中文"}>
    {next === "en" ? "EN" : "中文"}
  </button>;
  /* i18n-ignore-end */
}
