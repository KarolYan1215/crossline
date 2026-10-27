"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";

type Travel = { home: string; work: string; defaultMinutes: number; useMap: boolean };

/**
 * 出行 (2026-10-27): where the person lives and works, so an event at a place gets travel time before and after it. With a home address
 * and the map on, travel times come from OpenStreetMap; otherwise from the default, or the person is asked once per place.
 */
export function TravelCard({ initial }: { initial: Travel }) {
  const [draft, setDraft] = useState(initial);
  const [status, setStatus] = useState("");
  const save = async (next: Travel) => {
    setDraft(next);
    const response = await fetch("/api/settings/travel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(next) }).catch(() => null);
    setStatus(response?.ok ? "已保存" : "未保存");
  };
  return <section className="st-card" id="travel" aria-label="出行">
    <header><h3>出行</h3><small>有地点的日程前后留出路上时间，排程避开这段时间；线上日程不留</small></header>
    <div className="st-row"><label className="st-row-label">住址<small>填写后，有地点的日程由 OpenStreetMap 估算路上时间；住址与日程地点会发给 OpenStreetMap</small>
      <input value={draft.home} maxLength={200} placeholder="街道、城市" onChange={(event) => setDraft({ ...draft, home: event.target.value })}
        onBlur={() => draft.home !== initial.home && void save(draft)} /></label></div>
    <div className="st-row"><label className="st-row-label">工作或学习地点<small>日程地点写「公司」「学校」时按这里估算</small>
      <input value={draft.work} maxLength={200} placeholder="可留空" onChange={(event) => setDraft({ ...draft, work: event.target.value })}
        onBlur={() => draft.work !== initial.work && void save(draft)} /></label></div>
    <div className="st-row"><span className="st-row-label">地图估算<small>关闭后不向任何服务发送地址</small></span>
      <SegmentedControl label="地图估算" value={draft.useMap ? "on" : "off"} onChange={(value) => void save({ ...draft, useMap: value === "on" })}
        options={[{ value: "on", label: "开启" }, { value: "off", label: "关闭" }]} /></div>
    <div className="st-row"><span className="st-row-label">默认路上时间<small>没有住址或地图估算不到时使用；不设则逐个地点询问，期间按 30 分钟留</small></span>
      <SegmentedControl label="默认路上时间" value={String(draft.defaultMinutes)} onChange={(value) => void save({ ...draft, defaultMinutes: Number(value) })}
        options={[{ value: "0", label: "逐个询问" }, ...[15, 30, 45, 60].map((minutes) => ({ value: String(minutes), label: `${minutes} 分钟` }))]} /></div>
    {status && <small role="status" className={status === "已保存" ? "st-ok" : "st-fail"}>{status}</small>}
  </section>;
}
