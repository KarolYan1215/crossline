"use client";

import { useState } from "react";
import { useT } from "../locale-context";

/**
 * 出生日期 (2026-11-11; the year alone before that day): optional and never prompted; the owner's rule is to ask only whether the person
 * wants to give it. Given, its age places the energy prior's phase until their own sleep or best hours do (docs/energy-and-ecosystem.md
 * §2.1), and the day is kept for marking the birthday later; 「不填」 clears it. A year kept from before is not turned into a made-up day:
 * the box stays empty and says which year is on file until the person picks the day.
 */
export function BirthDateCard({ initial, legacyYear }: { initial: string | null; legacyYear: string | null }) {
  const t = useT();
  const [value, setValue] = useState(initial ?? "");
  const [year, setYear] = useState(legacyYear);
  const [status, setStatus] = useState<"" | "ok" | "fail">("");
  const save = async (birthDate: string | null) => {
    const response = await fetch("/api/settings/birth-date", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ birthDate }) }).catch(() => null);
    if (!response?.ok) { setStatus("fail"); return; }
    if (birthDate === null) setValue("");
    setYear(null);
    setStatus("ok");
  };
  return <section className="st-card" id="birth-date" aria-label={t("出生日期")}>
    <header><h3>{t("出生日期")}</h3></header>
    <div className="st-row"><span className="st-row-label">{t("愿意填写出生日期吗？")}<small>{year && !value ? t("之前只填了年份 {{year}}，补上月日即可", { year }) : t("只存在本账号里，用于按年龄校准精力")}</small></span>
      <span>
        <input type="date" min="1926-01-01" max={`${new Date().getFullYear() - 14}-12-31`} value={value} aria-label={t("出生日期")}
          onChange={(event) => { setValue(event.target.value); setStatus(""); }} />
        <button type="button" className="secondary-button" disabled={!value} onClick={() => void save(value)}>{t("保存")}</button>
        <button type="button" className="secondary-button" onClick={() => void save(null)}>{t("不填")}</button>
      </span></div>
    {status && <small role="status" className={status === "ok" ? "st-ok" : "st-fail"}>{status === "ok" ? t("已保存") : t("未保存")}</small>}
  </section>;
}
