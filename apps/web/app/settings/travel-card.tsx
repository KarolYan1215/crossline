"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { useT } from "../locale-context";

type Travel = { home: string; work: string; defaultMinutes: number; useMap: boolean };

/**
 * 出行 (2026-10-27): where the person lives and works, so an event at a place gets travel time before and after it. With a home address
 * and the map on, travel times come from OpenStreetMap; otherwise from the default, or the person is asked once per place.
 */
export function TravelCard({ initial }: { initial: Travel }) {
  const t = useT();
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState<"" | "ok" | "fail">("");
  const save = async (next: Travel) => {
    setDraft(next);
    const response = await fetch("/api/settings/travel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next) }).catch(() => null);
    setStatus(response?.ok ? "ok" : "fail");
  };
  return <section className="st-card" id="travel" aria-label={t("出行")}>
    <header><h3>{t("出行")}</h3><small>{t("有地点的日程前后留出路上时间，排程避开这段时间；线上日程不留")}</small></header>
    <div className="st-row"><label className="st-row-label">{t("住址")}<small>{t("填写后，有地点的日程由 OpenStreetMap 估算路上时间；住址与日程地点会发给 OpenStreetMap")}</small>
      <input value={draft.home} maxLength={200} placeholder={t("街道、城市")} onChange={(event) => setDraft({ ...draft, home: event.target.value })}
        onBlur={() => draft.home !== initial.home && void save(draft)} /></label></div>
    <div className="st-row"><label className="st-row-label">{t("工作或学习地点")}<small>{t("日程地点写「公司」「学校」时按这里估算")}</small>
      <input value={draft.work} maxLength={200} placeholder={t("可留空")} onChange={(event) => setDraft({ ...draft, work: event.target.value })}
        onBlur={() => draft.work !== initial.work && void save(draft)} /></label></div>
    <div className="st-row"><span className="st-row-label">{t("地图估算")}<small>{t("关闭后不向任何服务发送地址")}</small></span>
      <SegmentedControl label={t("地图估算")} value={draft.useMap ? "on" : "off"} onChange={(value) => void save({ ...draft, useMap: value === "on" })}
        options={[{ value: "on", label: t("开启", { context: "state" }) }, { value: "off", label: t("关闭", { context: "state" }) }]} /></div>
    <div className="st-row"><span className="st-row-label">{t("默认路上时间")}<small>{t("没有住址或地图估算不到时使用；不设则逐个地点询问，期间按 30 分钟留")}</small></span>
      <SegmentedControl label={t("默认路上时间")} value={String(draft.defaultMinutes)} onChange={(value) => void save({ ...draft, defaultMinutes: Number(value) })}
        options={[{ value: "0", label: t("逐个询问") }, ...[15, 30, 45, 60].map((minutes) => ({ value: String(minutes), label: t("{{count}} 分钟", { count: minutes }) }))]} /></div>
    {status && <small role="status" className={status === "ok" ? "st-ok" : "st-fail"}>{status === "ok" ? t("已保存") : t("未保存")}</small>}
  </section>;
}
