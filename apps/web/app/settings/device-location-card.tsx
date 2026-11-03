"use client";

import { useState } from "react";
import { SegmentedControl } from "../ui/controls";
import { useT } from "../locale-context";

type State = { on: boolean; reading?: { at: string; city?: string | undefined; country?: string | undefined } | undefined };

/**
 * 设备位置 (docs/opportunity-agent.md §17.6 a): off unless turned on. Pressing the button asks the browser for this device's position once;
 * the server keeps it rounded to about 1 km, only the latest, and the opportunity check uses it to tell where the person is today.
 */
export function DeviceLocationCard({ initial }: { initial: State }) {
  const t = useT();
  const [state, setState] = useState(initial);
  const [status, setStatus] = useState<"" | "ok" | "fail" | "denied">("");
  const toggle = async (on: boolean) => {
    const response = await fetch("/api/settings/device-location", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ on }) }).catch(() => null);
    if (!response?.ok) { setStatus("fail"); return; }
    setState(await response.json() as State);
    setStatus("ok");
  };
  const locate = () => {
    if (!navigator.geolocation) { setStatus("fail"); return; }
    navigator.geolocation.getCurrentPosition(async (position) => {
      const response = await fetch("/api/location/device", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ lat: position.coords.latitude, lon: position.coords.longitude }) }).catch(() => null);
      if (!response?.ok) { setStatus("fail"); return; }
      const fresh = await fetch("/api/settings/device-location").then((reply) => reply.json() as Promise<State>).catch(() => undefined);
      if (fresh) setState(fresh);
      setStatus("ok");
    }, () => setStatus("denied"), { enableHighAccuracy: false, maximumAge: 30 * 60_000, timeout: 20_000 });
  };
  const where = state.reading ? [state.reading.city, state.reading.country].filter(Boolean).join(", ") : "";
  return <section className="st-card" id="device-location" aria-label={t("设备位置")}>
    <header><h3>{t("设备位置")}</h3><small>{t("判断机会是否去得了时用来确定本人今天在哪里；只保留最近一次、精确到约 1 公里，不记录轨迹；关闭即删除")}</small></header>
    <div className="st-row"><span className="st-row-label">{t("使用设备位置")}<small>{t("位置所在城市由 OpenStreetMap 查出")}</small></span>
      <SegmentedControl label={t("使用设备位置")} value={state.on ? "on" : "off"} onChange={(value) => void toggle(value === "on")}
        options={[{ value: "on", label: t("开启", { context: "state" }) }, { value: "off", label: t("关闭", { context: "state" }) }]} /></div>
    {state.on && <div className="st-row"><span className="st-row-label">{t("最近一次")}<small>{state.reading
      ? t("{{day}} {{where}}", { day: state.reading.at.slice(0, 10), where: where || t("城市待查") }) : t("还没有")}</small></span>
      <button type="button" className="secondary-button" onClick={locate}>{t("用这台设备的位置")}</button></div>}
    {status && <small role="status" className={status === "ok" ? "st-ok" : "st-fail"}>
      {status === "ok" ? t("已保存") : status === "denied" ? t("浏览器没有给出位置") : t("未保存")}</small>}
  </section>;
}
