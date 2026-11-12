"use client";

import { useState } from "react";
import { useT } from "../locale-context";

/**
 * 出生年份 (2026-11-11): optional and never prompted; the owner's rule is to ask only whether the person wants to give it. Given, it places
 * the energy prior's phase until their own sleep or best hours do (docs/energy-and-ecosystem.md §2.1); 「不填」 clears it.
 */
export function BirthYearCard({ initial }: { initial: number | null }) {
  const t = useT();
  const [value, setValue] = useState(initial === null ? "" : String(initial));
  const [status, setStatus] = useState<"" | "ok" | "fail">("");
  const save = async (birthYear: number | null) => {
    const response = await fetch("/api/settings/birth-year", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ birthYear }) }).catch(() => null);
    if (!response?.ok) { setStatus("fail"); return; }
    if (birthYear === null) setValue("");
    setStatus("ok");
  };
  return <section className="st-card" id="birth-year" aria-label={t("出生年份")}>
    <header><h3>{t("出生年份")}</h3></header>
    <div className="st-row"><span className="st-row-label">{t("愿意填写出生年份吗？")}</span>
      <span>
        <input type="number" inputMode="numeric" min={1926} max={2012} value={value} aria-label={t("出生年份")} onChange={(event) => setValue(event.target.value)} />
        <button type="button" className="secondary-button" disabled={!value} onClick={() => void save(Number(value))}>{t("保存")}</button>
        <button type="button" className="secondary-button" onClick={() => void save(null)}>{t("不填")}</button>
      </span></div>
    {status && <small role="status" className={status === "ok" ? "st-ok" : "st-fail"}>{status === "ok" ? t("已保存") : t("未保存")}</small>}
  </section>;
}
