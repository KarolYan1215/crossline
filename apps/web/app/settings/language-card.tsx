"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { useLocale, useT } from "../locale-context";
import type { Locale } from "../../lib/i18n";

/** Each language is named in itself, whatever the page's language. */
const OPTIONS = [{ value: "zh", label: "中文" }, { value: "en", label: "English" }] as const; // i18n-ignore

/**
 * 界面语言 in Settings → 通用 (docs/i18n.md): the same choice as the 「中 / EN」 switch in the page head. It saves on click like every
 * other choice here and goes back if the save fails; once saved the whole page reloads, so every part comes back in the new language.
 */
export function LanguageCard() {
  const t = useT();
  const current = useLocale();
  const [value, setValue] = useState<Locale>(current);
  const [failed, setFailed] = useState(false);
  const change = async (next: Locale) => {
    setValue(next); setFailed(false);
    const response = await fetch("/api/locale", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ locale: next }) })
      .catch(() => undefined);
    if (!response?.ok) { setValue(current); setFailed(true); return; }
    location.reload();
  };
  return <section className="st-card" aria-label={t("界面语言")} id="language">
    <header><h3>{t("界面语言")}</h3><small>{t("应用里的文字；登录这个账号的其他设备也会改用它")}</small></header>
    <div className="st-row"><span className="st-row-label">{t("语言")}<small>{t("已经写好的内容保持原来的语言，之后新写的内容按这里的选择。")}</small></span>
      <SegmentedControl label={t("界面语言")} value={value} onChange={(next) => void change(next)} options={OPTIONS} />
      {failed && <small role="status" className="st-fail">{t("未保存")}</small>}
    </div>
  </section>;
}
